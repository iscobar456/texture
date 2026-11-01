import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import 'auth_errors.dart';
import 'supabase.dart';

enum _State { uploading, sent, failed }

class _Upload {
  _Upload(this.file) : state = _State.uploading;
  final XFile file;
  _State state;
  String? error;
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
  final _uploads = <_Upload>[]; // this session only, newest first
  int? _waiting; // photos still pending on the desktop

  @override
  void initState() {
    super.initState();
    _loadWaiting();
  }

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
      _loadWaiting();
    } catch (e) {
      if (mounted) {
        setState(() {
          u.state = _State.failed;
          u.error = friendlyError(e);
        });
      }
    }
  }

  Future<void> _pick(ImageSource source) async {
    final f = await _picker.pickImage(source: source);
    if (f == null) return;
    final u = _Upload(f);
    setState(() => _uploads.insert(0, u));
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
