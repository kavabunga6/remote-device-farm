# Android-тесты в Jenkins

[Jenkins Shared Library](jenkins-library.md) · [Все интеграции и их статус](README.md) · [API и CLI](../api/README.md) · [Maestro](maestro.md)

[Jenkinsfile](../../examples/jenkins/Jenkinsfile) запускается в репозитории Android-приложения. Он собирает APK, получает устройство через `ci/rdf.sh run`, выполняет инструментальные тесты и сохраняет результаты. CLI обслуживает очередь, продлевает аренду и ждёт подтверждения освобождения.

## Размеры памяти устройства и параметры запуска

Все настройки передаются через общий CLI: `RDF_DISK_GB` — внутренняя память Android, `RDF_SD_CARD_MB` — SD-карта, `RDF_EMULATOR_PARAMS` — дополнительные разрешённые аргументы. Они задаются до `rdf.sh run`; [значения и ограничения](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска) совпадают с веб-интерфейсом.

Добавьте нужные переменные в блок `environment` Jenkinsfile, например `RDF_DISK_GB = '16'` и `RDF_SD_CARD_MB = '1024'`.

## Подготовить агент

Нужен выделенный Linux-агент с метками `linux` и `device-farm`, Bash, `curl`, `jq`, GNU `timeout`, `tee`, `adb`, JDK и Android SDK проекта. Агент должен видеть HTTPS фермы и её ADB-порты через доверенную сеть или VPN.

В аккаунте фермы создайте личный API-токен и добавьте публичный ADB-ключ. На Jenkins-агенте заранее настройте ADB с соответствующим закрытым ключом. Скопируйте ID публичного ключа из аккаунта в `RDF_ADB_KEY_ID`: наличие ключа в ферме само по себе не настраивает локальный ADB.

Для одного ADB-сервера используйте одного исполнителя Jenkins и выделенную учётную запись ОС. `disableConcurrentBuilds()` ограничивает только эту Pipeline; другие jobs на том же хосте требуют отдельного окружения. Для параллельных тестов нужны отдельные агенты либо контейнеры с собственными ADB-сервером и домашним каталогом.

## Подключить репозиторий приложения

Скопируйте файлы, сохранив окончания строк LF:

| Файл фермы | Путь в репозитории приложения |
| --- | --- |
| [scripts/rdf.sh](../../scripts/rdf.sh) | `ci/rdf.sh` |
| [examples/jenkins/android-tests.sh](../../examples/jenkins/android-tests.sh) | `ci/android-tests.sh` |
| [examples/jenkins/Jenkinsfile](../../examples/jenkins/Jenkinsfile) | `Jenkinsfile` |

`gradlew` должен иметь право выполнения в Git. Shell-файлы вызываются через Bash, поэтому им это право не требуется. Добавьте `rdf-artifacts/` в `.gitignore` приложения.

В доступном job хранилище Jenkins Credentials создайте **Secret text** с ID `rdf-api-token`. Значение — личный токен CI-аккаунта фермы. В `Jenkinsfile` замените `RDF_URL`, `RDF_PROFILE` и `RDF_ADB_KEY_ID` реальными значениями.

Создайте Pipeline from SCM или Multibranch Pipeline с этим Jenkinsfile. Требуются обычные компоненты Jenkins: Declarative Pipeline, Credentials Binding и JUnit. Отдельного плагина фермы в примере нет.

Токен попадает в `RDF_TOKEN` через `withCredentials`. Вызов `sh` использует строку без Groovy-интерполяции, трассировка команд отключена через `set +x`. Не вставляйте токен прямо в Jenkinsfile и не включайте печать окружения. Это соответствует [правилам Jenkins для credentials](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/).

## Что выполняет Pipeline

1. Проверяет инструменты и собирает `assembleDebug` и `assembleDebugAndroidTest`. `clean` убирает результаты прежней сборки до получения устройства.
2. Запускает `bash ci/rdf.sh run -- bash ci/android-tests.sh`. Тестовый скрипт получает `ANDROID_SERIAL` от CLI.
3. Выполняет `connectedDebugAndroidTest` с лимитом 20 минут. Обработчик завершения сохраняет logcat до освобождения устройства и возвращает исходный код ошибки тестов.
4. В `post { always }` публикует JUnit и архивирует логи, HTML-отчёт и XML. Архивация выполняется и при ошибке публикации JUnit. [Документация Jenkins о результатах и артефактах](https://www.jenkins.io/doc/pipeline/tour/tests-and-artifacts/).

Пример рассчитан на модуль `app` и вариант `debug`. Для своего проекта измените Gradle-задачи и оба шаблона путей отчётов в Jenkinsfile: `app/build/outputs/androidTest-results/connected/**/*.xml` и `app/build/reports/androidTests/**`. `allowEmptyResults` позволяет завершить публикацию, если ошибка запуска произошла ещё до тестов; это не проверка наличия тестов в вашем проекте.

Для Maestro замените команду внутри `ci/android-tests.sh` на установку APK и запуск flow, как в [руководстве Maestro](maestro.md#сохранить-junit-и-logcat). Сохраните JUnit внутри `RDF_ARTIFACT_DIR` и измените путь `junit testResults` на этот файл.

Для Appium скопируйте каталог [примера](../../examples/appium/) в `ci/appium`, выполните `npm ci --prefix ci/appium` до получения устройства, а внутри `ci/android-tests.sh` запустите `RDF_ARTIFACTS_DIR="$RDF_ARTIFACT_DIR" node ci/appium/run.mjs`. Укажите для публикации JUnit файл `appium.xml` из каталога артефактов сборки. [Настройка Appium](appium.md).

## Таймауты, отмена и восстановление

У каждого build свой `rdf-artifacts/<BUILD_NUMBER>/session.json` внутри workspace job. Лимиты примера: 900 секунд на очередь и запуск, 60 на подключение ADB, 20 минут на тесты и 180 секунд на освобождение. Общий лимит Pipeline — 60 минут; при изменении тестов оставьте время для сборки, очереди, logcat и очистки.

Если очистка не подтверждена, CLI сохраняет `session.json` и завершает успешные тесты с ошибкой. При падении тестов сохраняется их код. В артефактах остаются `build.log`, `rdf-run.log`, `logcat.txt`, `logcat-errors.txt` и, при необходимости, файл восстановления. Файл состояния содержит параметры запроса и ID, без API-токена и закрытого ключа.

Скачайте сохранённый `session.json`, задайте прежний `RDF_URL` и токен того же аккаунта через защищённое окружение, затем повторите:

```bash
export RDF_STATE_FILE="$PWD/session.json"
bash ci/rdf.sh release 180
```

Не удаляйте оставшееся состояние и не очищайте workspace до сохранения файла восстановления. Если остался каталог `session.json.lock`, сначала убедитесь, что старый процесс остановлен; только после этого можно снять устаревшую блокировку. Подробности — [в справочнике CLI](../api/README.md#если-запрос-или-освобождение-прервались).

Обычную отмену CLI обрабатывает через сигналы. При принудительном убийстве или потере агента финальные логи и артефакты могут не сохраниться; прекращение продления аренды инициирует серверную очистку. Слот освобождается после подтверждения агента фермы. Не вызывайте общий `adb kill-server` из job.

## Если Pipeline не запускается

- **Задание ждёт агента:** проверьте метки `linux` и `device-farm`, доступность агента и число исполнителей.
- **Не найдены credentials:** Secret text должен быть доступен этой job под ID `rdf-api-token`.
- **Ошибка до аренды устройства:** откройте `build.log`, проверьте инструменты, `gradlew` и задачи сборки.
- **Нет JUnit:** проверьте журнал тестов и путь модуля/варианта; `allowEmptyResults` разрешает отсутствие отчётов, когда тесты не начались.
- **Не собран logcat:** подробности находятся в `logcat-errors.txt`. При потере CI-агента последние артефакты могут не сохраниться.

## Статус проверки

Шаблон использует [официальный Declarative Pipeline syntax](https://www.jenkins.io/doc/book/pipeline/syntax/). Его необходимо проверить на вашем Jenkins, с установленными компонентами и Android-проектом; запуск на живом Jenkins здесь не подтверждён.
