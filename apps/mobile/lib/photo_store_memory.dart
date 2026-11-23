import 'dart:typed_data';

import 'package:flutter/painting.dart';

/// Keeps photos in memory only (the web build): the list starts empty on
/// every page load. Uploads are unaffected, they already live on the server.
class PhotoStore {
  static final _photos = <String, Uint8List>{};
  static var _next = 0;

  static Future<List<Map<String, dynamic>>> loadIndex() async => [];

  static Future<void> saveIndex(List<Map<String, dynamic>> entries) async {}

  static Future<String> add(Uint8List jpeg) async {
    final key = 'mem:${_next++}';
    _photos[key] = jpeg;
    return key;
  }

  static Future<Uint8List> read(String key) async =>
      _photos[key] ?? (throw StateError('Photo is no longer available.'));

  static Future<void> remove(String key) async => _photos.remove(key);

  static ImageProvider image(String key) => MemoryImage(_photos[key]!);
}
