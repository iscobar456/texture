import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/painting.dart';
import 'package:path_provider/path_provider.dart';

import 'supabase.dart';

/// Photos are files named by their key (the full path), with `index.json`
/// holding the list entries in order.
class PhotoStore {
  static Directory? _dir;

  static Future<Directory> _folder() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/sent/${sb.auth.currentUser!.id}');
    await d.create(recursive: true);
    return _dir = d;
  }

  static File _index(Directory d) => File('${d.path}/index.json');

  /// Saved entries whose photo is still there. Each has a `key`.
  static Future<List<Map<String, dynamic>>> loadIndex() async {
    final d = await _folder();
    final f = _index(d);
    if (!await f.exists()) return [];
    final list = jsonDecode(await f.readAsString()) as List;
    return [
      for (final m in list.cast<Map<String, dynamic>>())
        // `path` is what older versions called the key.
        if (File((m['key'] ?? m['path']) as String).existsSync())
          {...m, 'key': m['key'] ?? m['path']},
    ];
  }

  static Future<void> saveIndex(List<Map<String, dynamic>> entries) async {
    final d = _dir ?? await _folder();
    final f = _index(d);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode(entries));
    await tmp.rename(f.path);
  }

  /// Stores an edited JPEG and returns its key.
  static Future<String> add(Uint8List jpeg) async {
    final d = _dir ?? await _folder();
    final dest = File('${d.path}/${DateTime.now().microsecondsSinceEpoch}.jpg');
    await dest.writeAsBytes(jpeg, flush: true);
    return dest.path;
  }

  static Future<Uint8List> read(String key) => File(key).readAsBytes();

  static Future<void> remove(String key) async {
    try {
      await File(key).delete();
    } on FileSystemException {
      // Already gone.
    }
  }

  static ImageProvider image(String key) => FileImage(File(key));
}
