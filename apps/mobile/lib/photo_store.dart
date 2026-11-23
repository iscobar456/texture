/// Where sent photos and the list of sends are kept between runs.
///
/// On the phone: files in the app's support folder with a JSON index beside
/// them, so the list survives restarts. On the web: in memory for the tab's
/// lifetime, since browser storage is too small for photos.
library;

export 'photo_store_memory.dart' if (dart.library.io) 'photo_store_io.dart';
