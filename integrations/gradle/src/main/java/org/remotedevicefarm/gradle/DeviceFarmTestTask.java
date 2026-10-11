package org.remotedevicefarm.gradle;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.inject.Inject;
import org.gradle.api.DefaultTask;
import org.gradle.api.GradleException;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.Property;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.Internal;
import org.gradle.api.tasks.OutputDirectory;
import org.gradle.api.tasks.TaskAction;
import org.gradle.process.ExecOperations;
import org.gradle.work.DisableCachingByDefault;

@DisableCachingByDefault(because = "Each execution rents a new device and runs external tests.")
public abstract class DeviceFarmTestTask extends DefaultTask {
    @Input public abstract Property<String> getUrl();
    @Input public abstract Property<String> getProfile();
    @Input public abstract Property<String> getAdbKeyId();
    @Input public abstract Property<String> getTokenEnvironmentVariable();
    @Input public abstract Property<String> getBashExecutable();
    @Input public abstract ListProperty<String> getTestCommand();
    @Input public abstract Property<Integer> getStartTimeoutSeconds();
    @Input public abstract Property<Integer> getTestTimeoutSeconds();
    @OutputDirectory public abstract DirectoryProperty getArtifactsDirectory();
    @Internal public abstract DirectoryProperty getWorkingDirectory();
    @Inject protected abstract ExecOperations getExecOperations();

    @TaskAction
    public void runTests() throws IOException {
        validate();
        String tokenVariable = getTokenEnvironmentVariable().get();
        String token = System.getenv(tokenVariable);
        if (token == null || token.isBlank()) throw new GradleException("The configured Device Farm token environment variable is missing.");
        Path directory = getArtifactsDirectory().get().getAsFile().toPath().resolve(UUID.randomUUID().toString());
        Files.createDirectories(directory.resolve("tools"));
        Path cli = extract("rdf.sh", directory);
        Path runner = extract("run-tests.sh", directory);
        List<String> tests = new ArrayList<>(getTestCommand().get());
        // Nested Gradle must use a separate project cache; the outer build owns its cache lock.
        String executable = tests.get(0).replace('\\', '/');
        if (executable.endsWith("/gradlew") || executable.equals("gradlew") || executable.equals("gradle")) {
            if (tests.stream().noneMatch(arg -> arg.startsWith("--project-cache-dir"))) {
                tests.add("--project-cache-dir");
                tests.add(shellPath(directory.resolve("gradle-cache")));
            }
        }
        List<String> command = new ArrayList<>(List.of(getBashExecutable().get(), shellPath(runner), "--"));
        command.addAll(tests);
        int exit = getExecOperations().exec(spec -> {
            spec.setWorkingDir(getWorkingDirectory().get().getAsFile());
            spec.setCommandLine(command);
            spec.setIgnoreExitValue(true);
            Map<String, Object> environment = spec.getEnvironment();
            environment.remove("RDF_TOKEN");
            environment.remove(tokenVariable);
            // A fresh task may not pick up a previous CLI request from the caller's environment.
            environment.remove("RDF_SESSION");
            environment.remove("RDF_STATE_FILE");
            environment.remove("RDF_CLI_SCRIPT");
            spec.environment(Map.ofEntries(
                Map.entry("RDF_TOKEN", token), Map.entry("RDF_TOKEN_VARIABLE", tokenVariable),
                Map.entry("RDF_URL", getUrl().get()), Map.entry("RDF_PROFILE", getProfile().get()),
                Map.entry("RDF_ADB_KEY_ID", getAdbKeyId().get()),
                Map.entry("RDF_ARTIFACT_DIR", shellPath(directory)),
                Map.entry("RDF_STATE_FILE", shellPath(directory.resolve("session.json"))),
                Map.entry("RDF_CLI_SCRIPT", shellPath(cli)),
                Map.entry("RDF_START_TIMEOUT_SECONDS", getStartTimeoutSeconds().get().toString()),
                Map.entry("RDF_TEST_TIMEOUT_SECONDS", getTestTimeoutSeconds().get().toString())
            ));
        }).getExitValue();
        getLogger().lifecycle("Device Farm artifacts: {}", directory);
        if (exit != 0) throw new GradleException("Device Farm tests or cleanup failed (exit " + exit + "). See the task output and artifacts.");
    }

    private void validate() {
        URI url;
        try { url = URI.create(getUrl().get()); }
        catch (IllegalArgumentException problem) { throw new GradleException("Invalid Device Farm service URL."); }
        if (url.getScheme() == null || !List.of("http", "https").contains(url.getScheme()) || url.getHost() == null
            || url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null) {
            throw new GradleException("Device Farm URL must be an HTTP(S) address without credentials, query or fragment.");
        }
        if (getProfile().get().isBlank()) throw new GradleException("A Device Farm profile is required.");
        if (!getAdbKeyId().get().matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) {
            throw new GradleException("Device Farm adbKeyId must be a public-key UUID.");
        }
        if (!getTokenEnvironmentVariable().get().matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new GradleException("Invalid Device Farm token environment variable name.");
        }
        if (getTestCommand().get().isEmpty() || getTestCommand().get().stream().anyMatch(arg -> arg == null || arg.isBlank())) {
            throw new GradleException("Device Farm testCommand must contain an executable and nonempty arguments.");
        }
        for (int value : List.of(getStartTimeoutSeconds().get(), getTestTimeoutSeconds().get())) {
            if (value < 1 || value > 86400) throw new GradleException("Device Farm timeouts must be 1-86400 seconds.");
        }
    }

    private Path extract(String resource, Path directory) throws IOException {
        Path destination = directory.resolve("tools").resolve(resource);
        try (InputStream stream = getClass().getResourceAsStream("/rdf/" + resource)) {
            if (stream == null) throw new GradleException("The Device Farm plugin package is missing its CLI resources.");
            Files.copy(stream, destination);
        }
        return destination;
    }

    private static String shellPath(Path path) { return path.toAbsolutePath().toString().replace('\\', '/'); }
}
