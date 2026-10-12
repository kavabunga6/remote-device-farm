package org.remotedevicefarm.teamcity;

import java.net.URI;
import java.nio.file.Path;
import java.util.*;

public final class RunnerSettings {
    public static final String TYPE = "remote-device-farm";
    public static final Map<String,String> DEFAULTS = Map.ofEntries(
        Map.entry("testScript","ci/android-tests.sh"),Map.entry("prepareScript",""),Map.entry("environmentScript",""),
        Map.entry("artifactsDirectory","rdf-artifacts"),Map.entry("tokenVariable","RDF_TOKEN"),
        Map.entry("adbKeyFile",""),Map.entry("caFile",""),Map.entry("startTimeoutSeconds","900"),
        Map.entry("testTimeoutSeconds","1200"),Map.entry("junitReport","app/build/outputs/androidTest-results/connected/**/*.xml"));
    public static final class InputException extends IllegalArgumentException {
        public final String field;
        public InputException(String field,String message){super(message);this.field=field;}
    }
    private static InputException invalid(String field,String message){return new InputException(field,message);}
    public static Map<String,String> validate(Map<String,String> input) {
        Map<String,String> values=new LinkedHashMap<>(DEFAULTS);values.putAll(input);
        for (String name:List.of("url","profile","adbKeyId","testScript")) if (values.getOrDefault(name,"").isBlank()) throw invalid(name,"This runner option is required");
        for (var entry:values.entrySet()) {String value=entry.getValue();if (value==null || value.contains("\n") || value.contains("\r") || value.indexOf(0)>=0) throw invalid(entry.getKey(),"Use a single-line value");}
        URI url;try{url=URI.create(values.get("url"));}catch(IllegalArgumentException failure){throw invalid("url","Use a verified HTTPS service URL");}
        if (!"https".equals(url.getScheme()) || url.getHost()==null || url.getUserInfo()!=null || url.getQuery()!=null || url.getFragment()!=null) throw invalid("url","Use a verified HTTPS service URL");
        if (!values.get("tokenVariable").matches("[A-Za-z_][A-Za-z0-9_]*")) throw invalid("tokenVariable","Use an environment variable name");
        for (String name:List.of("testScript","prepareScript","environmentScript","artifactsDirectory","junitReport")) {
            String value=values.get(name);
            if (value.startsWith("/") || value.contains("\\") || Arrays.asList(value.split("/")).contains("..")) throw invalid(name,"Use a relative checkout path without ..");
        }
        if (!values.get("artifactsDirectory").matches("[A-Za-z0-9_./-]+") || ".".equals(values.get("artifactsDirectory"))) throw invalid("artifactsDirectory","Use a relative artifacts directory");
        for (String name:List.of("startTimeoutSeconds","testTimeoutSeconds")) {
            String value=values.get(name);
            if (!value.matches("[1-9][0-9]{0,4}") || Integer.parseInt(value)>86400) throw invalid(name,"Use 1 to 86400 seconds");
        }
        if (!values.get("adbKeyId").matches("[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}")) throw invalid("adbKeyId","Use a public ADB key UUID");
        return values;
    }
    public static Map<String,String> environment(Map<String,String> options,Map<String,String> inherited,Path run,Path tools,String label) {
        Map<String,String> env=new LinkedHashMap<>(inherited);
        String token=inherited.get(options.get("tokenVariable"));
        if (token==null || token.isEmpty()) throw new IllegalArgumentException("Configured API token is missing");
        env.put("RDF_TOKEN",token);env.put("RDF_TOKEN_VARIABLE",options.get("tokenVariable"));
        Map<String,String> names=Map.ofEntries(Map.entry("url","RDF_URL"),Map.entry("profile","RDF_PROFILE"),Map.entry("adbKeyId","RDF_ADB_KEY_ID"),
            Map.entry("testScript","RDF_TEST_SCRIPT"),Map.entry("prepareScript","RDF_PREPARE_SCRIPT"),Map.entry("environmentScript","RDF_ENV_SCRIPT"),
            Map.entry("adbKeyFile","RDF_ADB_KEY_FILE"),Map.entry("caFile","RDF_CA_FILE"),Map.entry("startTimeoutSeconds","RDF_START_TIMEOUT_SECONDS"),
            Map.entry("testTimeoutSeconds","RDF_TEST_TIMEOUT_SECONDS"));
        names.forEach((name,variable)->env.put(variable,options.get(name)));
        env.put("RDF_ARTIFACT_DIR",run.toString());env.put("RDF_STATE_FILE",run.resolve("session.json").toString());
        env.put("RDF_TOOL_DIR",tools.toString());env.put("RDF_LABEL",label);return env;
    }
    public static String escape(String value) {
        return value.replace("|","||").replace("'","|'").replace("\n","|n").replace("\r","|r").replace("[","|[").replace("]","|]");
    }
    private RunnerSettings() {}
}
