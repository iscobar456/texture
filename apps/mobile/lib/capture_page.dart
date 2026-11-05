import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import 'auth_errors.dart';
import 'edit_photo_page.dart';
import 'supabase.dart';

enum _State { uploading, sent, failed }

class _Upload {
  _Upload(this.file, {this.state = _State.uploading});
  final XFile file;
  _State state;
  String? error;

  Map<String, dynamic> toJson() => {'path': file.path, 'state': state.name};
}

/// The sent list survives restarts: edited photos are kept in the app's
/// support folder (not the OS temp dir) with a small JSON index beside them.
class _History {
  static const _keep = 50;
  static Directory? _dir;

  static Future<Directory> _folder() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/sent/${sb.auth.currentUser!.id}');
    await d.create(recursive: true);
    return _dir = d;
  }

  static File _index(Directory d) => File('${d.path}/index.json');

  static Future<List<_Upload>> load() async {
    final d = await _folder();
    final f = _index(d);
    if (!await f.exists()) return [];
    try {
      final list = jsonDecode(await f.readAsString()) as List;
      return [
        for (final m in list)
          if (File(m['path'] as String).existsSync())
            _Upload(
              XFile(m['path'] as String),
              // A send cut short by closing the app is retryable.
              state: m['state'] == 'sent' ? _State.sent : _State.failed,
            ),
      ];
    } catch (_) {
      return [];
    }
  }

  /// Moves a freshly edited photo out of temp storage.
  static Future<String> adopt(String tmp) async {
    final d = _dir ?? await _folder();
    final dest = '${d.path}/${DateTime.now().microsecondsSinceEpoch}.jpg';
    try {
      await File(tmp).rename(dest);
    } on FileSystemException {
      await File(tmp).copy(dest);
      await File(tmp).delete().catchError((_) => File(tmp));
    }
    return dest;
  }

  static Future<void> save(List<_Upload> uploads) async {
    final d = _dir ?? await _folder();
    for (final u in uploads.skip(_keep)) {
      await File(u.file.path).delete().catchError((_) => File(u.file.path));
    }
    final kept = uploads.take(_keep).toList();
    final f = _index(d);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode([for (final u in kept) u.toJson()]));
    await tmp.rename(f.path);
  }
}

final _bigButton = FilledButton.styleFrom(
  minimumSize: const Size.fromHeight(64),
  textStyle: const TextStyle(fontSize: 18),
  iconSize: 28,
);

class CapturePage extends StatefulWidget {
  const CapturePage({super.key});

  @override
  State<CapturePage> createState() => _CapturePageState();
}

class _CapturePageState extends State<CapturePage> {
  final _picker = ImagePicker();
  final _uploads = <_Upload>[]; // newest first, persisted by _History
  int? _waiting; // photos still pending on the desktop

  @override
  void initState() {
    super.initState();
    _loadWaiting();
    _History.load().then((saved) {
      if (!mounted) return;
      // Anything added while loading stays on top.
      setState(() => _uploads.addAll(saved));
    }).catchError((_) {});
  }

  void _persist() => _History.save(_uploads).catchError((_) {});

  Future<void> _loadWaiting() async {
    try {
      final rows = await sb.from('photos').select('id').eq('status', 'pending');
      if (mounted) setState(() => _waiting = rows.length);
    } catch (_) {
      // Purely informational; stay quiet if offline.
    }
  }

  Future<void> _upload(_Upload u) async {
    setState(() {
      u.state = _State.uploading;
      u.error = null;
    });
    try {
      final uid = sb.auth.currentUser!.id;
      final ext = u.file.path.split('.').last;
      final path = '$uid/${DateTime.now().microsecondsSinceEpoch}.$ext';
      await sb.storage.from('photos').upload(path, File(u.file.path));
      await sb.from('photos').insert({'storage_path': path});
      if (mounted) setState(() => u.state = _State.sent);
      _persist();
      _loadWaiting();
    } catch (e) {
      if (mounted) {
        setState(() {
          u.state = _State.failed;
          u.error = friendlyError(e);
        });
        _persist();
      }
    }
  }

  Future<void> _pick(ImageSource source) async {
    final f = await _picker.pickImage(source: source);
    if (f == null || !mounted) return;
    final edited = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => EditPhotoPage(path: f.path)),
    );
    if (edited == null) return; // cancelled
    final u = _Upload(XFile(await _History.adopt(edited)));
    if (!mounted) return;
    setState(() => _uploads.insert(0, u));
    _persist();
    await _upload(u);
  }

  Future<void> _signOut() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (ok == true) await sb.auth.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final email = sb.auth.currentUser?.email ?? '';
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.topRight,
              child: PopupMenuButton<String>(
                icon: const Icon(Icons.account_circle_outlined),
                tooltip: 'Account',
                onSelected: (_) => _signOut(),
                itemBuilder: (_) => [
                  PopupMenuItem(enabled: false, child: Text(email)),
                  const PopupMenuItem(value: 'out', child: Text('Sign out')),
                ],
              ),
            ),
            Expanded(
              child: _uploads.isEmpty
                  ? Center(
                      child: Icon(
                        Icons.document_scanner_outlined,
                        size: 96,
                        color: theme.colorScheme.outlineVariant,
                      ),
                    )
                  : ListView.builder(
                      itemCount: _uploads.length,
                      itemBuilder: (_, i) => _uploadTile(_uploads[i], theme),
                    ),
            ),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        'Photograph your paper or whiteboard work, or pick an '
                        'existing photo. It goes to the photo inbox in your '
                        'Texture desktop app, ready to insert into your homework.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyMedium,
                      ),
                      if (_waiting != null && _waiting! > 0)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            '$_waiting waiting in your desktop inbox',
                            textAlign: TextAlign.center,
                            style: theme.textTheme.bodySmall,
                          ),
                        ),
                      const SizedBox(height: 20),
                      FilledButton.icon(
                        style: _bigButton,
                        onPressed: () => _pick(ImageSource.camera),
                        icon: const Icon(Icons.photo_camera),
                        label: const Text('Take photo'),
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        style: _bigButton,
                        onPressed: () => _pick(ImageSource.gallery),
                        icon: const Icon(Icons.photo_library),
                        label: const Text('Choose from gallery'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _uploadTile(_Upload u, ThemeData theme) => ListTile(
    leading: ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: Image.file(
        File(u.file.path),
        width: 48,
        height: 48,
        fit: BoxFit.cover,
        cacheWidth: 96,
      ),
    ),
    title: Text(switch (u.state) {
      _State.uploading => 'Sending…',
      _State.sent => 'Sent to desktop inbox',
      _State.failed => 'Failed to send',
    }),
    subtitle: u.error == null ? null : Text(u.error!),
    trailing: switch (u.state) {
      _State.uploading => const SizedBox(
        width: 24,
        height: 24,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
      _State.sent => Icon(Icons.check_circle, color: theme.colorScheme.primary),
      _State.failed => TextButton(
        onPressed: () => _upload(u),
        child: const Text('Retry'),
      ),
    },
  );
}
