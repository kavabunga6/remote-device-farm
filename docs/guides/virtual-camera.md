# Virtual camera images

Compatible emulator images expose a virtual rear camera. In a device session, open Environment → Virtual camera and upload a PNG or JPEG image. Open the rear camera in the Android application, then select Move view to image.

The image is placed on the wall in Android Emulator's virtual scene. It is not a full-frame camera replacement. The movement command starts the emulator's bundled route to the image room; applications must keep their rear-camera preview open while it runs.

The browser accepts files up to 10 MiB and converts them to a PNG no larger than 1024 × 1024 pixels and 256 KiB. Images with high detail may be resized further. The agent validates PNG structure, checksums and bounded decompression, and removes metadata before passing the image to the emulator.

Restore scene resets the poster and removes the uploaded image. Session cleanup removes the entire emulator container and its image data. Uploaded images are not added to profiles, the APK library or the registry.

## Requirements

- A running emulator session accessible to its owner or an authorized administrator and the sessions.env permission.
- A phone/tablet image with hw.camera.back=virtualscene.
- Android Emulator support for virtualscene-image and the bundled Walk_to_image_room macro.
- The standard image layout under /opt/android and /android-home.

Newly built standard phone/tablet images configure the virtual scene rear camera. Existing images may need rebuilding. Images with another camera backend, physical phones and unsupported form factors report that the virtual camera is unavailable. Host webcams are not accessed.

The UI reads camera support only when its section is open. It displays confirmed image state, or an unknown state if an update could not be confirmed. Restore the scene before retrying an uncertain update.

## API

All routes use the existing API authentication and ownership checks:

| Method | Path suffix after /api/sessions/SESSION_ID | Operation |
| --- | --- | --- |
| GET | /camera | Availability and image state |
| POST | /camera/image | Multipart field image containing a normalized PNG |
| POST | /camera/show | Move the virtual camera toward the image room |
| POST | /camera/reset | Restore the default poster and remove the image |

imageSet is true after a confirmed update, false after a reset, and null when an image file exists without confirmation. A successful movement response confirms that the emulator accepted playback; it does not prove that an application recognized the image.

## Verification

PNG validation, console/IPC allowlists, container ownership and HTTP permissions have automated coverage. Browser upload, state changes, reset and control alignment are checked in Russian/English, light/dark themes and enlarged text.

A live Android 16 Google APIs phone check covered PNG upload, macro positioning, application preview frames, QR decoding from an actual camera frame and image reset. Other images, camera APIs and concurrent sessions remain **Not tested**.
