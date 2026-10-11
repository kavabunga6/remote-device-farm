package org.remotedevicefarm.gradle;

import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.Property;

public abstract class DeviceFarmExtension {
    public abstract Property<String> getUrl();
    public abstract Property<String> getProfile();
    public abstract Property<String> getAdbKeyId();
    public abstract Property<String> getTokenEnvironmentVariable();
    public abstract Property<String> getBashExecutable();
    public abstract ListProperty<String> getTestCommand();
    public abstract ListProperty<String> getPrepareTasks();
    public abstract DirectoryProperty getArtifactsDirectory();
    public abstract Property<Integer> getStartTimeoutSeconds();
    public abstract Property<Integer> getTestTimeoutSeconds();
}
