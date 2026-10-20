# Installing APK sets

The application library accepts:

| Format | Installation |
| --- | --- |
| .apk | One signed APK |
| .apks | A bundletool APK set; matching parts are selected for the device |
| .zip | A flat archive containing a base APK and its configuration or feature splits for one device configuration |

Upload the file in **Apps**, then install it into a running session. The existing application storage quotas and ownership rules apply. URL installation also supports .apks and .zip when the URL path has the corresponding extension. URLs without an extension retain single-APK behavior.

For a bundletool set, the agent reads the device's SDK level, ABI list, display density and locales. The pinned bundletool selects compatible parts before Android installs them. The standard agent image includes Java 17 and bundletool 1.18.3, downloaded at image build time with a fixed SHA256.

A flat ZIP does not contain bundletool targeting metadata: prepare its parts for one device configuration. All APKs must belong to the same application and compatible version and signing identity. Android validates the installation together. The service does not re-sign packages or remove application data to bypass a signature mismatch.

Archives are checked before extraction: paths, duplicate names, compression, sizes and CRC. ZIP64, encrypted archives and symbolic links are rejected. Limits are 2048 archive entries, 1000 APKs in an .apks set, 100 APKs in a flat ZIP, 256 MiB per expanded entry and 1 GiB total expanded data. At most 100 selected APKs are installed together. Storage upload limits may be lower.

AAB, XAPK, APKM, OBB expansion files and Play Asset Delivery installation are not supported by this workflow. Rebuild an appropriate .apks set from the original signed build when a device has no matching configuration.

The existing APIs remain unchanged: POST /api/apps uploads a package and POST /api/sessions/{id}/apps/install installs the caller's stored app. Binary storage paths are internal identifiers and do not determine the uploaded format.
