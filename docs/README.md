# Документация Remote Device Farm

## Первая установка

Пройдите три шага:

1. [Сервер](deployment/server.md): запустите веб-интерфейс и базу, войдите администратором.
2. [Агент](deployment/agent.md): подключите Linux-машину с Docker и KVM.
3. [Первая сессия](guides/sessions.md): выберите готовый профиль и откройте устройство.

**Сервер** обслуживает пользователей. **Узел** — машина с устройствами. **Агент** — программа на этом узле. **Слот** — место для одной сессии. **Профиль** описывает Android-окружение и его ресурсы. **Сессия** — ограниченный по времени доступ к устройству.

- [Скриншоты интерфейса](screenshots/README.md).

## Для пользователей

- [Сессии, файлы, консоль, запись экрана и ADB](guides/sessions.md).
- [Какие образы можно запускать](guides/images.md).
- [Если что-то не работает](troubleshooting.md).

## Для администраторов

- [Установка и обновление сервера](deployment/server.md).
- [Установка и обновление агента](deployment/agent.md).
- [Домашний старт, registry, HTTPS и каталог образов](deployment/registry.md).
- [Узлы, слоты, профили и пользователи](guides/administration.md).
- [Роли и разрешения на действия](guides/roles.md).
- [Образы: registry, кэш узлов и автоматическая очистка](guides/image-management.md).
- [Диагностика и журналы](troubleshooting.md).

## Для разработчиков и CI

- [Локальная разработка с живым обновлением UI](development.md).
- [Единый словарь и перевод интерфейса](guides/localization.md).
- [Практические примеры API](api/README.md).
- [Описание HTTP API в OpenAPI](api/openapi.yaml).
- [Интеграции: быстрый запуск, состав и статус проверок](ci/README.md).
- [GitHub Action](ci/github-actions.md), [GitLab CI Component](ci/gitlab-component.md) и [Azure Pipelines Task](ci/azure-pipelines.md).
- [Maestro](ci/maestro.md) и [Appium](ci/appium.md) через CLI фермы.
- [GitLab CI Component](ci/gitlab-component.md), [Jenkins Shared Library](ci/jenkins-library.md) и [Gradle-плагин](ci/gradle.md): пакеты автоматизации.
- [TeamCity build runner](ci/teamcity.md), [CircleCI Orb](ci/circleci.md) и [Bitbucket Pipe](ci/bitbucket-pipelines.md).
- [Требования CI и восстановление](ci/native-packages.md).

## Дополнительные материалы

Дополнительные сценарии:

- [Устройство USB-провайдера](device-providers.md) и [очистка физических устройств](usb-reset-script.md).
- [Разбор безопасности физических устройств](security-audit-devices.md).
- [Границы безопасности сервиса](../SECURITY.md).
- [Пример размещения в homelab](../deploy/homelab/README.md).
- [Сетевые правила для изоляции устройств](../deploy/firewall/README.md) — отдельная настройка операционной системы, базовая установка её не выполняет.
- [Технический справочник API и протокола](reference/server.md).
- [Готовые и собственные Docker-образы](emulator-images.md).
- [Чек-лист релиза](release-checklist.md) и [статус проверок](verification.md).
- [Участие в разработке](../CONTRIBUTING.md), [лицензия](../LICENSE) и [сторонние компоненты](../THIRD_PARTY.md).
- [Secret scan](security/secret-scan.md) и [список лицензий зависимостей](security/dependency-licenses.json).

Команды развёртывания рассчитаны на Bash в Linux. Для разработки интерфейса подходят также Windows и macOS. Адреса `farm.example.com` и `192.0.2.10` в примерах нужно заменить своими. Команды с `docker compose` выполняются из каталога репозитория, если не указано другое.
