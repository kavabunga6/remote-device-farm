# Тесты Android в GitHub Actions

[Все интеграции и их статус](README.md) · [API и CLI](../api/README.md)

Этот workflow выполняется в репозитории Android-приложения. CLI занимает устройство через очередь, поддерживает аренду во время тестов и ждёт подтверждённого освобождения.

## Размеры памяти устройства и параметры запуска

Все настройки передаются через общий CLI: `RDF_DISK_GB` — внутренняя память Android, `RDF_SD_CARD_MB` — SD-карта, `RDF_EMULATOR_PARAMS` — дополнительные разрешённые аргументы. Они задаются до `rdf.sh run`; [значения и ограничения](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска) совпадают с веб-интерфейсом.

## Подготовить runner

Нужен выделенный Linux runner с Bash, `curl`, `jq`, GNU `timeout`, `adb`, JDK и Android SDK вашего проекта. Runner должен видеть HTTPS фермы и её ADB-порты через доверенную сеть или VPN.

1. Создайте CI-аккаунт в ферме и выпустите личный API-токен.
2. Добавьте публичный ADB-ключ в этот аккаунт. На runner заранее настройте ADB с парным закрытым ключом. Не меняйте ключи уже работающего общего ADB-сервера из задания.
3. В GitHub сохраните секрет `RDF_TOKEN`. В Variables добавьте `RDF_URL`, `RDF_PROFILE` и `RDF_ADB_KEY_ID` — ID добавленного ключа.
4. Скопируйте [rdf.sh](../../scripts/rdf.sh) в `ci/rdf.sh` репозитория приложения.

Пример рассчитан на один ADB-сервер для одного задания. Для параллельных запусков используйте отдельные runner или контейнеры с отдельным ADB-сервером и домашним каталогом. Номера файлов состояния не изолируют сам ADB.

## Команда тестов

Сохраните `ci/android-tests.sh`:

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

`ANDROID_SERIAL` передаётся скрипту автоматически. Журнал сохраняется до освобождения устройства, даже если Gradle завершился с ошибкой. Gradle не получает API-токен; для сбора logcat он остаётся только в скрипте-обёртке. Тесты ограничены 20 минутами: оставшееся время job нужно для сборки, ожидания устройства, logcat и освобождения. Для другого модуля или варианта измените Gradle-задачи и пути отчётов.

## Workflow

```yaml
name: Android UI tests
on: workflow_dispatch

concurrency:
  group: device-farm
  cancel-in-progress: false

jobs:
  instrumented:
    runs-on: [self-hosted, linux, device-farm]
    timeout-minutes: 60
    defaults:
      run:
        shell: bash
    env:
      RDF_URL: ${{ vars.RDF_URL }}
      RDF_PROFILE: ${{ vars.RDF_PROFILE }}
      RDF_ADB_KEY_ID: ${{ vars.RDF_ADB_KEY_ID }}
      RDF_LABEL: gh-${{ github.run_number }}
      RDF_STATE_FILE: .rdf-session-${{ github.run_id }}-${{ github.run_attempt }}
      RDF_START_TIMEOUT_SECONDS: '900'
    steps:
      - uses: actions/checkout@v4
      - name: Проверить инструменты
        run: |
          for tool in adb curl jq timeout java; do command -v "$tool"; done
      - name: Собрать APK до получения устройства
        run: env -u RDF_TOKEN ./gradlew clean assembleDebug assembleDebugAndroidTest --no-daemon
      - name: Запустить тесты на устройстве фермы
        env:
          RDF_TOKEN: ${{ secrets.RDF_TOKEN }}
        run: |
          set +x
          bash ci/rdf.sh run -- bash ci/android-tests.sh
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: android-test-results
          path: |
            logcat.txt
            app/build/reports/androidTests/
            app/build/outputs/androidTest-results/connected/
            .rdf-session-*
          include-hidden-files: true
          if-no-files-found: ignore
```

Файл `.rdf-session-*` остаётся только если очистку не удалось подтвердить. Он содержит ID и параметры запроса, без API-токена или закрытого ключа. Сохраните его для повторного `release`. Каталог `.lock` в артефакте — след блокировки, а не подтверждение работающего процесса.

## Ошибки и отмена

- Нет подходящего свободного места — запрос ждёт в очереди до выделения устройства или истечения таймаута.
- Ключ не подходит — `connect` завершится по таймауту, затем CLI запросит освобождение.
- Тест упал — задание сохранит код ошибки тестов; CLI всё равно выполнит очистку.
- Runner исчез — продление аренды прекратится. Сервер запросит остановку после её истечения; занятый слот освободится после подтверждения агента.

Во время обычной отмены CLI обрабатывает `SIGINT`/`SIGTERM`. Принудительное убийство процесса не позволяет выполнить финальный шаг; для этого и используется серверный срок аренды. [Справочник CLI](../api/README.md#готовый-помощник-для-ci) описывает восстановление.

## Статус проверки

Это пример workflow, отдельного GitHub Action фермы нет. Проверки CLI выполняются в CI репозитория; запуск этого workflow на self-hosted runner с Android-проектом пока не подтверждён. Перед использованием проверьте успешный тест, ошибку теста, отмену и сохранение артефактов на своём runner.
