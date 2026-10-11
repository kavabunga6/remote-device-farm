package org.remotedevicefarm

class DeviceFarmConfiguration implements Serializable {
    String url
    String profile
    String adbKeyId
    String credentialsId
    String testScript = 'ci/android-tests.sh'
    String prepareScript = ''
    String artifactsDirectory = 'rdf-artifacts'
    String junitReport = 'app/build/outputs/androidTest-results/connected/**/*.xml'
    String startTimeoutSeconds = '900'
    String testTimeoutSeconds = '1200'

    String adbKeyCredentialsId = ''
    String caCredentialsId = ''
    String environmentScript = ''
    boolean publishReports = true
    String label = ''

    Map asMap() {
        [url: url, profile: profile, adbKeyId: adbKeyId, credentialsId: credentialsId,
         testScript: testScript, prepareScript: prepareScript, artifactsDirectory: artifactsDirectory,
         junitReport: junitReport, startTimeoutSeconds: startTimeoutSeconds, testTimeoutSeconds: testTimeoutSeconds,
         adbKeyCredentialsId: adbKeyCredentialsId, caCredentialsId: caCredentialsId,
         environmentScript: environmentScript, publishReports: publishReports, label: label]
    }
}
