package org.remotedevicefarm.gradle;

import java.util.List;
import org.gradle.api.Plugin;
import org.gradle.api.Project;

public final class DeviceFarmPlugin implements Plugin<Project> {
    @Override
    public void apply(Project project) {
        DeviceFarmExtension extension = project.getExtensions().create("deviceFarm", DeviceFarmExtension.class);
        extension.getTokenEnvironmentVariable().convention("RDF_TOKEN");
        extension.getBashExecutable().convention("bash");
        extension.getPrepareTasks().convention(List.of(":app:assembleDebug", ":app:assembleDebugAndroidTest"));
        extension.getTestCommand().convention(List.of("./gradlew", ":app:connectedDebugAndroidTest", "--no-daemon"));
        extension.getArtifactsDirectory().convention(project.getLayout().getBuildDirectory().dir("device-farm"));
        extension.getStartTimeoutSeconds().convention(900);
        extension.getTestTimeoutSeconds().convention(1200);
        project.getTasks().register("deviceFarmTest", DeviceFarmTestTask.class, task -> {
            task.setGroup("verification");
            task.setDescription("Run Android tests on a Remote Device Farm device.");
            task.getUrl().set(extension.getUrl());
            task.getProfile().set(extension.getProfile());
            task.getAdbKeyId().set(extension.getAdbKeyId());
            task.getTokenEnvironmentVariable().set(extension.getTokenEnvironmentVariable());
            task.getBashExecutable().set(extension.getBashExecutable());
            task.getTestCommand().set(extension.getTestCommand());
            task.getArtifactsDirectory().set(extension.getArtifactsDirectory());
            task.getStartTimeoutSeconds().set(extension.getStartTimeoutSeconds());
            task.getTestTimeoutSeconds().set(extension.getTestTimeoutSeconds());
            task.getWorkingDirectory().set(project.getRootProject().getLayout().getProjectDirectory());
            task.dependsOn(extension.getPrepareTasks());
            task.getOutputs().upToDateWhen(ignored -> false);
        });
    }
}
