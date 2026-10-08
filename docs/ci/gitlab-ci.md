# Тесты Android в GitLab CI

[Все интеграции и их статус](README.md) · [API и CLI](../api/README.md)

Пример рассчитан на Linux runner с Shell executor. Устройство выделяет очередь фермы, а CLI поддерживает аренду и освобождает её после команды тестов.

## Размеры памяти устройства и параметры запуска

Все настройки передаются через общий CLI: `RDF_DISK_GB` — внутренняя память Android, `RDF_SD_CARD_MB` — SD-карта, `RDF_EMULATOR_PARAMS` — дополнительные разрешённые аргументы. Они задаются до `rdf.sh run`; [значения и ограничения](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска) совпадают с веб-интерфейсом.

## Подготовить runner

1. Установите Bash, `curl`, `jq`, GNU `timeout`, `adb`, JDK и Android SDK проекта.
2. Создайте CI-аккаунт в ферме. Выпустите личный API-токен и добавьте публичный ADB-ключ. Парный закрытый ключ заранее настройте для ADB-сервера runner.
3. В **Settings → CI/CD → Variables** задайте `RDF_URL`, `RDF_PROFILE`, `RDF_ADB_KEY_ID` и masked-секрет `RDF_TOKEN`.
4. Обеспечьте доступ runner к HTTPS сервера и ADB-портам через доверенную сеть или VPN.
5. Скопируйте [rdf.sh](../../scripts/rdf.sh) в `ci/rdf.sh` репозитория приложения.

Для одного ADB-сервера запускайте по одному заданию. При увеличении параллельности нужны отдельные ADB-серверы и домашние каталоги runner. `resource_group` ниже ограничивает задания только внутри одного проекта.

## Команда тестов

Сохраните `ci/android-tests.sh`. Путь отчётов и Gradle-задачу замените под свой модуль:

```bash
#!/usr/bin/env bash
set +x
set -euo pipefail
collect_logs() {
  result=$?
  trap - EXIT
  bash ci/rdf.sh logs 2000 > logcat.txt || true
  exit "$result"
}
trap collect_logs EXIT
timeout --signal=TERM --kill-after=30s 20m \
  env -u RDF_TOKEN ./gradlew connectedDebugAndroidTest --no-daemon
```

CLI передаст `ANDROID_SERIAL` и ID сессии. Журнал собирается до её освобождения. Gradle не получает API-токен; для logcat он остаётся в скрипте-обёртке. Тесты ограничены 20 минутами. Общий лимит задания оставляет время на сборку, очередь и очистку.

## `.gitlab-ci.yml`

```yaml
stages: [test]

instrumented-tests:
  stage: test
  tags: [device-farm]
  timeout: 60m
  resource_group: device-farm
  variables:
    RDF_LABEL: gitlab-$CI_PIPELINE_IID
    RDF_STATE_FILE: .rdf-session-$CI_JOB_ID
    RDF_START_TIMEOUT_SECONDS: '900'
  before_script:
    - for tool in adb curl jq timeout java; do command -v "$tool"; done
  script:
    - set +x
    - env -u RDF_TOKEN ./gradlew clean assembleDebug assembleDebugAndroidTest --no-daemon
    - bash ci/rdf.sh run -- bash ci/android-tests.sh
  artifacts:
    when: always
    paths:
      - logcat.txt
      - app/build/reports/androidTests/
      - app/build/outputs/androidTest-results/connected/
      - .rdf-session-*
    reports:
      junit: app/build/outputs/androidTest-results/connected/**/*.xml
    expire_in: 1 week
```

Очистка входит в команду `run`. Если тест прошёл, но очистка не подтверждена, само задание завершится с ошибкой. Если тест упал, сохраняется его код завершения, а проблема очистки отдельно печатается в журнале.

## Если runner пропал

При обычной ошибке или `SIGTERM` CLI запросит освобождение. При потере runner или `SIGKILL` сервер обнаружит отсутствие продления аренды и запросит остановку устройства. Недоступный агент не даёт подтвердить очистку: слот остаётся зарезервированным до его возвращения.

Если сохранился `.rdf-session-*`, используйте этот файл и тот же аккаунт для повторного освобождения:

```sh
export RDF_STATE_FILE='.rdf-session-12345'
bash ci/rdf.sh release 180
```

После аварийного завершения может остаться каталог `<RDF_STATE_FILE>.lock`. Перед снятием блокировки убедитесь, что исходное задание остановлено. [Подробнее о CLI и восстановлении](../api/README.md#если-запрос-или-освобождение-прервались).

## Статус проверки

Это пример конфигурации Shell runner, отдельного расширения GitLab фермы нет. Команды сверены с CLI; живой запуск job с Android-проектом пока не подтверждён. Проверьте в своём проекте успешный и упавший тест, отмену, JUnit и освобождение слота.
