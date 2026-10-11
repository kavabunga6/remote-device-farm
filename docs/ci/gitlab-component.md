# GitLab CI Component

[Все интеграции](README.md) · [Шаблон компонента](../../templates/device-farm.yml)

Компонент создаёт задание тестов: подготовка приложения, очередь устройства, подключение ADB, выполнение скрипта, сбор logcat и скриншота, освобождение сессии. Используется общий CLI. Его файлы скачиваются из закреплённого коммита и проверяются по SHA256 до запуска.

## Подключить

Нужен GitLab 17+ и подготовленный Linux runner: Bash, curl, jq, GNU timeout, sha256sum, tee, Android Platform Tools и инструменты сборки приложения. Закрытый ADB-ключ должен быть доступен ADB-серверу runner; его публичную часть добавьте в аккаунт сервиса. Сохраните API-токен в masked/protected переменной `RDF_TOKEN`.

В репозитории приложения создайте `ci/build.sh` и `ci/android-tests.sh`:

```bash
# ci/build.sh
set -euo pipefail
./gradlew assembleDebug assembleDebugAndroidTest --no-daemon
```

```bash
# ci/android-tests.sh
set -euo pipefail
: "${ANDROID_SERIAL:?device is not connected}"
./gradlew connectedDebugAndroidTest --no-daemon
```

Подключение из GitHub через `include: remote`:

```yaml
stages: [test]
include:
  - remote: https://raw.githubusercontent.com/kavabunga6/remote-device-farm/main/templates/device-farm.yml
    inputs:
      url: https://farm.example.com
      profile: android-30
      adb-key-id: 33333333-3333-4333-8333-333333333333
      prepare-script: ci/build.sh
      test-script: ci/android-tests.sh
```

Для воспроизводимой конфигурации замените `main` на полный SHA выбранного коммита. Для `include: component` создайте зеркало этого репозитория на той же GitLab-инсталляции, где находится проект приложения:

```yaml
include:
  - component: $CI_SERVER_FQDN/platform/remote-device-farm/device-farm@<commit-sha>
    inputs:
      url: https://farm.example.com
      profile: android-30
      adb-key-id: 33333333-3333-4333-8333-333333333333
      prepare-script: ci/build.sh
```

Компонент не опубликован в GitLab CI/CD Catalog. Подключение к своему зеркалу по SHA не требует публикации в Catalog. [Контракт компонентов GitLab](https://docs.gitlab.com/ci/components/).

## Параметры

| Input | Значение |
| --- | --- |
| `url`, `profile`, `adb-key-id` | Обязательные адрес сервиса, профиль и публичный ключ |
| `job-name`, `stage` | `device-farm-tests`, `test` |
| `runner-tags` | Массив меток runner, по умолчанию `[device-farm]` |
| `resource-group` | `device-farm`; ограничивает параллельность внутри проекта |
| `token-variable` | Имя секретной переменной, по умолчанию `RDF_TOKEN`; сам токен не передаётся через inputs |
| `prepare-script` | Необязательный скрипт сборки до аренды |
| `test-script` | `ci/android-tests.sh`; получает `ANDROID_SERIAL`, `RDF_SESSION`, `RDF_ARTIFACT_DIR` |
| `junit-report` | `app/build/outputs/androidTest-results/connected/**/*.xml` |
| `test-timeout-seconds`, `start-timeout-seconds` | `1200`, `900`; положительные целые до 86400 |

Размеры устройства и другие параметры задаются переменными `RDF_DISK_GB`, `RDF_SD_CARD_MB`, `RDF_EMULATOR_PARAMS`. [Общий контракт](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска). Таймаут job составляет 60 минут; при изменении таймаутов оставьте время на подготовку, очередь, тесты и очистку.

## Артефакты и отмена

В `rdf-artifacts/$CI_JOB_ID/` сохраняются `test.log`, `logcat.txt`, `screenshot.png` и диагностика сбора. JUnit берётся из указанного пути. API-токен исключается из окружения скриптов сборки и тестов. Каталог восстановления может содержать `session.json`, но не токен.

CLI обрабатывает обычную отмену и ждёт подтверждения очистки. При потере runner устройство освобождается через истечение аренды; недоступный агент сохраняет слот занятым до подтверждения. Последние артефакты при принудительной остановке могут не сохраниться. [Восстановление](../api/README.md#если-запрос-или-освобождение-прервались).

Для параллельных заданий нужны отдельные ADB-серверы и домашние каталоги runner. `resource-group` не изолирует задания разных проектов.

## Проверки

Локальные тесты проверяют выполнение скриптов, отсутствие токена у тестов, коды ошибок, сохранение артефактов и отказ при несовпадении SHA256. Запуск компонента в GitLab, CI Lint на выбранной версии, отмена job и публикация JUnit: **Not tested**.
