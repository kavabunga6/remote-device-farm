import org.remotedevicefarm.DeviceFarmConfiguration

def call(Closure configure) {
    def configuration = new DeviceFarmConfiguration()
    configure.resolveStrategy = Closure.DELEGATE_ONLY
    configure.delegate = configuration
    configure()
    call(configuration.asMap())
}

def call(Map configuration) {
    def allowed = ['url', 'profile', 'adbKeyId', 'credentialsId', 'testScript', 'prepareScript',
                   'artifactsDirectory', 'junitReport', 'startTimeoutSeconds', 'testTimeoutSeconds',
                   'adbKeyCredentialsId', 'caCredentialsId', 'environmentScript', 'publishReports', 'label'] as Set
    if (!allowed.containsAll(configuration.keySet())) error('deviceFarm: unknown configuration option')
    def defaults = [testScript: 'ci/android-tests.sh', prepareScript: '', artifactsDirectory: 'rdf-artifacts',
                    junitReport: 'app/build/outputs/androidTest-results/connected/**/*.xml',
                    startTimeoutSeconds: '900', testTimeoutSeconds: '1200', adbKeyCredentialsId: '',
                    caCredentialsId: '', environmentScript: '', publishReports: true, label: '']
    def settings = defaults + configuration
    for (def name in ['url', 'profile', 'adbKeyId', 'credentialsId', 'testScript']) {
        if (!(settings[name] instanceof String) || !settings[name].trim()) error('deviceFarm: required configuration is missing')
    }
    for (def entry in settings) {
        if (entry.key == 'publishReports') {
            if (!(entry.value instanceof Boolean)) error('deviceFarm: publishReports must be a boolean')
        } else if (!(entry.value instanceof String) || entry.value.contains('\n') || entry.value.contains('\r')) {
            error('deviceFarm: configuration values must be single-line strings')
        }
    }
    for (def name in ['artifactsDirectory', 'testScript', 'prepareScript', 'junitReport', 'environmentScript']) {
        def value = settings[name]
        if (value && (value.startsWith('/') || value.contains('\\') || value.split('/').contains('..'))) {
            error('deviceFarm: file paths must stay inside the workspace')
        }
    }
    if (!(settings.artifactsDirectory ==~ '[A-Za-z0-9_./-]+') || settings.artifactsDirectory == '.') {
        error('deviceFarm: invalid artifacts directory')
    }
    for (def name in ['startTimeoutSeconds', 'testTimeoutSeconds']) {
        if (!(settings[name] ==~ /[1-9][0-9]{0,4}/) || settings[name].toInteger() > 86400) {
            error('deviceFarm: timeout must be 1-86400 seconds')
        }
    }
    if (!isUnix()) error('deviceFarm: a Linux agent is required')
    def runDirectory = settings.artifactsDirectory + '/' + UUID.randomUUID().toString()
    def environment = [
        'RDF_URL=' + settings.url, 'RDF_PROFILE=' + settings.profile, 'RDF_ADB_KEY_ID=' + settings.adbKeyId,
        'RDF_TEST_SCRIPT=' + settings.testScript, 'RDF_PREPARE_SCRIPT=' + settings.prepareScript,
        'RDF_ARTIFACT_DIR=' + runDirectory, 'RDF_STATE_FILE=' + runDirectory + '/session.json',
        'RDF_START_TIMEOUT_SECONDS=' + settings.startTimeoutSeconds, 'RDF_TEST_TIMEOUT_SECONDS=' + settings.testTimeoutSeconds,
        'RDF_LABEL=' + (settings.label ?: env.RDF_LABEL ?: 'jenkins-' + (env.BUILD_NUMBER ?: 'build')),
        'RDF_TOKEN_VARIABLE=RDF_TOKEN', 'RDF_ENV_SCRIPT=' + settings.environmentScript,
        'RDF_CLI_SCRIPT=' + runDirectory + '/tools/rdf.sh', 'RDF_RUNNER_SCRIPT=' + runDirectory + '/tools/run-tests.sh',
        'RDF_RUNTIME_SCRIPT=' + runDirectory + '/tools/jenkins-runtime.sh',
        'RDF_CLEANUP_SCRIPT=' + runDirectory + '/tools/jenkins-cleanup.sh'
    ]
    def bindings = [string(credentialsId: settings.credentialsId, variable: 'RDF_TOKEN')]
    if (settings.adbKeyCredentialsId) bindings.add(file(credentialsId: settings.adbKeyCredentialsId, variable: 'RDF_ADB_KEY_FILE'))
    if (settings.caCredentialsId) bindings.add(file(credentialsId: settings.caCredentialsId, variable: 'RDF_CA_FILE'))
    def failure = null
    withEnv(environment) {
        try {
            sh(script: '''#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
[ -z "$RDF_ENV_SCRIPT" ] || source "$RDF_ENV_SCRIPT"
[ -f "$RDF_TEST_SCRIPT" ]
mkdir -p -- "$RDF_ARTIFACT_DIR/tools"
if [ -n "$RDF_PREPARE_SCRIPT" ]; then env -u RDF_TOKEN bash "$RDF_PREPARE_SCRIPT"; fi
''')
            for (def resource in ['rdf.sh', 'run-tests.sh', 'jenkins-runtime.sh', 'jenkins-cleanup.sh']) {
                writeFile(file: runDirectory + '/tools/' + resource, text: libraryResource('rdf/' + resource), encoding: 'UTF-8')
            }
            withCredentials(bindings) {
                try {
                    sh(script: '''#!/usr/bin/env bash
set +x
set -euo pipefail
bash "$RDF_RUNTIME_SCRIPT"
''')
                } catch (problem) {
                    failure = problem
                } finally {
                    try {
                        sh(script: '''#!/usr/bin/env bash
set +x
set -euo pipefail
bash "$RDF_CLEANUP_SCRIPT"
''')
                    } catch (problem) {
                        echo('deviceFarm: managed cleanup failed; preserve recovery evidence')
                        if (failure == null) failure = problem
                    }
                }
                if (failure != null) throw failure
            }
        } catch (problem) {
            failure = problem
        } finally {
            if (settings.publishReports) {
                try {
                    junit(testResults: settings.junitReport, allowEmptyResults: true)
                } catch (problem) {
                    echo('deviceFarm: JUnit publication failed')
                    if (failure == null) failure = problem
                }
                try {
                    archiveArtifacts(artifacts: runDirectory + '/**,' + settings.junitReport,
                                     allowEmptyArchive: true, followSymlinks: false)
                } catch (problem) {
                    echo('deviceFarm: artifact publication failed')
                    if (failure == null) failure = problem
                }
            }
        }
    }
    if (failure != null) throw failure
    return runDirectory
}
