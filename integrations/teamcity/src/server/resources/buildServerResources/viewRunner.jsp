<%@include file="runner-messages.jsp" %>
<%@ taglib prefix="props" tagdir="/WEB-INF/tags/props" %>
<%@ taglib prefix="l" tagdir="/WEB-INF/tags/layout" %>
<l:settingsGroup title="Remote Device Farm">
  <tr><th><c:out value="${rdf_url_label}"/>:</th><td><props:displayValue name="url" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_profile_label}"/>:</th><td><props:displayValue name="profile" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_adbKeyId_label}"/>:</th><td><props:displayValue name="adbKeyId" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_tokenVariable_label}"/>:</th><td><props:displayValue name="tokenVariable" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_prepareScript_label}"/>:</th><td><props:displayValue name="prepareScript" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_testScript_label}"/>:</th><td><props:displayValue name="testScript" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_environmentScript_label}"/>:</th><td><props:displayValue name="environmentScript" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_adbKeyFile_label}"/>:</th><td><props:displayValue name="adbKeyFile" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_caFile_label}"/>:</th><td><props:displayValue name="caFile" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_artifactsDirectory_label}"/>:</th><td><props:displayValue name="artifactsDirectory" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_junitReport_label}"/>:</th><td><props:displayValue name="junitReport" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_startTimeoutSeconds_label}"/>:</th><td><props:displayValue name="startTimeoutSeconds" emptyValue="—"/></td></tr>
  <tr><th><c:out value="${rdf_testTimeoutSeconds_label}"/>:</th><td><props:displayValue name="testTimeoutSeconds" emptyValue="—"/></td></tr>
</l:settingsGroup>
