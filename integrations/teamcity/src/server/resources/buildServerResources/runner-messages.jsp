<%@ page contentType="text/html;charset=UTF-8" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<c:set var="rdf_url_label" value="${pageContext.request.locale.language == 'ru' ? 'Адрес сервиса' : 'Service URL'}"/>
<c:set var="rdf_url_hint" value="${pageContext.request.locale.language == 'ru' ? 'HTTPS с проверенным сертификатом' : 'Verified HTTPS endpoint'}"/>
<c:set var="rdf_profile_label" value="${pageContext.request.locale.language == 'ru' ? 'Профиль устройства' : 'Device profile'}"/>
<c:set var="rdf_profile_hint" value="${pageContext.request.locale.language == 'ru' ? 'ID существующего профиля' : 'Existing profile ID'}"/>
<c:set var="rdf_adbKeyId_label" value="${pageContext.request.locale.language == 'ru' ? 'ID публичного ключа ADB' : 'Public ADB key ID'}"/>
<c:set var="rdf_adbKeyId_hint" value="${pageContext.request.locale.language == 'ru' ? 'UUID ключа аккаунта, которому принадлежит токен' : 'UUID registered for the token owner'}"/>
<c:set var="rdf_tokenVariable_label" value="${pageContext.request.locale.language == 'ru' ? 'Переменная с токеном' : 'Token environment variable'}"/>
<c:set var="rdf_tokenVariable_hint" value="${pageContext.request.locale.language == 'ru' ? 'Параметр сборки с типом Password и префиксом env.' : 'Define this build parameter with Password type and env. prefix'}"/>
<c:set var="rdf_prepareScript_label" value="${pageContext.request.locale.language == 'ru' ? 'Скрипт сборки' : 'Build script'}"/>
<c:set var="rdf_prepareScript_hint" value="${pageContext.request.locale.language == 'ru' ? 'Необязательный относительный путь; запускается до получения устройства' : 'Optional relative path, executed before allocation'}"/>
<c:set var="rdf_testScript_label" value="${pageContext.request.locale.language == 'ru' ? 'Скрипт тестов' : 'Test script'}"/>
<c:set var="rdf_testScript_hint" value="${pageContext.request.locale.language == 'ru' ? 'Относительный путь; получает ANDROID_SERIAL' : 'Relative path; receives ANDROID_SERIAL'}"/>
<c:set var="rdf_environmentScript_label" value="${pageContext.request.locale.language == 'ru' ? 'Окружение инструментов' : 'Tool environment'}"/>
<c:set var="rdf_environmentScript_hint" value="${pageContext.request.locale.language == 'ru' ? 'Необязательный shell-файл с относительным путём' : 'Optional relative shell file'}"/>
<c:set var="rdf_adbKeyFile_label" value="${pageContext.request.locale.language == 'ru' ? 'Файл закрытого ключа ADB' : 'Private ADB key file'}"/>
<c:set var="rdf_adbKeyFile_hint" value="${pageContext.request.locale.language == 'ru' ? 'Защищённый файл, доступный агенту' : 'Protected file already available to the agent'}"/>
<c:set var="rdf_caFile_label" value="${pageContext.request.locale.language == 'ru' ? 'Файл доверенного сертификата' : 'TLS trust file'}"/>
<c:set var="rdf_caFile_hint" value="${pageContext.request.locale.language == 'ru' ? 'PEM-файл; проверка HTTPS остаётся включённой' : 'Protected PEM file; HTTPS verification stays enabled'}"/>
<c:set var="rdf_artifactsDirectory_label" value="${pageContext.request.locale.language == 'ru' ? 'Каталог артефактов' : 'Artifacts directory'}"/>
<c:set var="rdf_artifactsDirectory_hint" value="${pageContext.request.locale.language == 'ru' ? 'Относительный путь; для каждого запуска создаётся свой каталог' : 'Relative path; each invocation uses a unique subdirectory'}"/>
<c:set var="rdf_junitReport_label" value="${pageContext.request.locale.language == 'ru' ? 'Отчёты JUnit' : 'JUnit reports'}"/>
<c:set var="rdf_junitReport_hint" value="${pageContext.request.locale.language == 'ru' ? 'Относительная маска файлов XML' : 'Relative XML report glob'}"/>
<c:set var="rdf_startTimeoutSeconds_label" value="${pageContext.request.locale.language == 'ru' ? 'Таймаут запуска, секунды' : 'Start timeout, seconds'}"/>
<c:set var="rdf_startTimeoutSeconds_hint" value="${pageContext.request.locale.language == 'ru' ? 'От 1 до 86400' : '1 to 86400'}"/>
<c:set var="rdf_testTimeoutSeconds_label" value="${pageContext.request.locale.language == 'ru' ? 'Таймаут тестов, секунды' : 'Test timeout, seconds'}"/>
<c:set var="rdf_testTimeoutSeconds_hint" value="${pageContext.request.locale.language == 'ru' ? 'От 1 до 86400' : '1 to 86400'}"/>
