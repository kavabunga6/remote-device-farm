# Jenkins Shared Library

[Все интеграции](README.md) · [Шаг deviceFarm](../../vars/deviceFarm.groovy)

Библиотека добавляет Pipeline-шаг `deviceFarm`. Он выполняет скрипт подготовки до аренды, запускает тесты с подключённым ADB-устройством, собирает logcat и скриншот, освобождает сессию и публикует артефакты. CLI включён в библиотеку: копировать его в проект приложения не требуется.

## Подключить библиотеку

В **Manage Jenkins → System → Global Pipeline Libraries** добавьте:

- Name: `remote-device-farm`.
- Default version: полный SHA выбранного коммита.
- Retrieval method: **Modern SCM → Git**.
- Project Repository: `https://github.com/kavabunga6/remote-device-farm.git`.

Каталоги `vars/`, `src/` и `resources/` расположены в корне репозитория. Библиотека использует стандартную [структуру Jenkins Shared Library](https://www.jenkins.io/doc/book/pipeline/shared-libraries/).

На Linux-агенте нужны Bash, curl, jq, GNU timeout, tee, ADB и инструменты приложения. Настройте закрытый ADB-ключ для пользователя агента и добавьте парную публичную часть в аккаунт сервиса. API-токен хранится в Jenkins Credentials типа **Secret text**, например `rdf-api-token`.

## Pipeline

```groovy
@Library('remote-device-farm') _

pipeline {
    agent { label 'linux && device-farm' }
    options { timeout(time: 60, unit: 'MINUTES') }
    stages {
        stage('Android tests') {
            steps {
                deviceFarm(
                    url: 'https://farm.example.com',
                    profile: 'android-30',
                    adbKeyId: '33333333-3333-4333-8333-333333333333',
                    credentialsId: 'rdf-api-token',
                    prepareScript: 'ci/build.sh',
                    testScript: 'ci/android-tests.sh'
                )
            }
        }
    }
}
```

`ci/build.sh` собирает APK и тестовый APK. `ci/android-tests.sh` запускает тесты, например `./gradlew connectedDebugAndroidTest --no-daemon`. Он получает `ANDROID_SERIAL`, `RDF_SESSION` и `RDF_ARTIFACT_DIR`; API-токен из его окружения удаляется.

Для Scripted Pipeline можно передать конфигурацию замыканием:

```groovy
node('linux && device-farm') {
    deviceFarm {
        url = 'https://farm.example.com'
        profile = 'android-30'
        adbKeyId = '33333333-3333-4333-8333-333333333333'
        credentialsId = 'rdf-api-token'
        testScript = 'ci/android-tests.sh'
    }
}
```

Замыкание задаёт параметры. Команды тестов выполняются в указанном shell-файле, чтобы CLI поддерживал аренду в течение всего запуска.

## Параметры

Обязательны `url`, `profile`, `adbKeyId`, `credentialsId`. Дополнительно:

| Параметр | По умолчанию |
| --- | --- |
| `testScript` | `ci/android-tests.sh` |
| `prepareScript` | Пусто; подготовка не выполняется |
| `artifactsDirectory` | `rdf-artifacts`; внутри создаётся уникальный каталог запуска |
| `junitReport` | `app/build/outputs/androidTest-results/connected/**/*.xml` |
| `startTimeoutSeconds` | `'900'` |
| `testTimeoutSeconds` | `'1200'` |

Все значения — строки. Пути должны быть относительными и оставаться внутри workspace. Параметры устройства `RDF_DISK_GB`, `RDF_SD_CARD_MB` и `RDF_EMULATOR_PARAMS` можно задать через `withEnv`. Для параллельных запусков необходимы отдельные ADB-окружения агента.

## Ошибки и артефакты

`deviceFarm` возвращает путь каталога запуска. В нём находятся `test.log`, `logcat.txt`, `screenshot.png`, диагностика и, если очистка не подтверждена, файл восстановления `session.json`. Публикация JUnit и артефактов выполняется также после ошибки подготовки или тестов; исходная ошибка сохраняется.

При обычной отмене CLI запрашивает освобождение. Потеря агента обрабатывается истечением аренды; при недоступности агента устройства слот остаётся зарезервированным. Принудительная остановка может прервать сбор или публикацию артефактов. [Повторное освобождение](../api/README.md#если-запрос-или-освобождение-прервались).

## Проверки

Локальные Groovy-тесты проверяют конфигурацию, порядок шагов, область credentials, публикацию после ошибок и сохранение исходной ошибки. Общий runner проверяется отдельно с Bash. Запуск на Jenkins с CPS, Credentials Binding, JUnit и Artifact Manager: **Not tested**.
