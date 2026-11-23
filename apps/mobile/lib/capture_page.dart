import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'auth_errors.dart';
import 'delete_account.dart';
import 'edit_photo_page.dart';
import 'photo_store.dart';
import 'supabase.dart';

enum _State { uploading, sent, failed }

class _Upload {
  _Upload(
    this.key, {
    this.state = _State.uploading,
    this.id,
    this.delivered = false,
    this.storagePath,
  });
  final String key; // the edited photo in PhotoStore
  _State state;
  String? error;
  String? id; // the photos row, once inserted
  /// Where the file goes in storage, fixed on the first attempt so a retry
  /// overwrites that upload instead of leaving an orphan beside a second copy.
  String? storagePath;
  bool delivered; // the desktop has shown it in its inbox

  Map<String, dynamic> toJson() => {
    'key': key,
    'state': state.name,
    'id': id,
    'delivered': delivered,
    'storagePath': storagePath,
  };
}

/// The sent list survives restarts where PhotoStore can keep it (the phone).
class _History {
  static const _keep = 50;

  static Future<List<_Upload>> load() async {
    try {
      return [
        for (final m in await PhotoStore.loadIndex())
          _Upload(
            m['key'] as String,
            // A send cut short by closing the app is retryable.
            state: m['state'] == 'sent' ? _State.sent : _State.failed,
            id: m['id'] as String?,
            delivered: m['delivered'] == true,
            storagePath: m['storagePath'] as String?,
          ),
      ];
    } catch (_) {
      return [];
    }
  }

  static Future<void> save(List<_Upload> uploads) async {
    for (final u in uploads.skip(_keep)) {
      await PhotoStore.remove(u.key);
    }
    await PhotoStore.saveIndex([for (final u in uploads.take(_keep)) u.toJson()]);
  }
}

final _bigButton = FilledButton.styleFrom(
  minimumSize: const Size.fromHeight(64),
  textStyle: const TextStyle(fontSize: 18),
  iconSize: 28,
);

const _helpTitle = 'Send your work to desktop';
const _helpText =
    'Photograph your paper or whiteboard work, or pick an existing photo. '
    '\nIt goes to the photo inbox in your Texture desktop app, ready to insert '
    'into your homework.';

class CapturePage extends StatefulWidget {
  const CapturePage({super.key});

  @override
  State<CapturePage> createState() => _CapturePageState();
}

class _CapturePageState extends State<CapturePage>
    with WidgetsBindingObserver {
  RealtimeChannel? _channel;
  Timer? _poll;
  bool _checking = false; // a delivery lookup is in flight
  final _picker = ImagePicker();
  final _uploads = <_Upload>[]; // newest first, persisted by _History

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _History.load().then((saved) {
      if (!mounted) return;
      // Anything added while loading stays on top.
      setState(() => _uploads.addAll(saved));
      _checkDelivery();
    }).catchError((_) {});
    // Realtime alone is not dependable on a phone (the socket can stall or drop
    // without notice), so while a sent photo is not yet delivered, also ask now
    // and then. A cheap query that stops by itself once everything is delivered.
    // Not gated on lifecycle state: timers don't fire while the app is
    // suspended anyway, and an `inactive`/`hidden` event with no `resumed`
    // after it used to switch polling off for good.
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _checkDelivery());
    // The desktop stamps delivered_at / status on the row; realtime only
    // works while foregrounded, so resume and (re)join also re-check.
    _channel = sb
        .channel('photo-delivery')
        .onPostgresChanges(
          event: PostgresChangeEvent.update,
          schema: 'public',
          table: 'photos',
          callback: (_) => _checkDelivery(),
        )
        .subscribe((status, _) {
          if (status == RealtimeSubscribeStatus.subscribed) _checkDelivery();
        });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    if (_channel != null) sb.removeChannel(_channel!);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _checkDelivery();
    }
  }

  /// Looks up the rows of sent photos not yet known to be delivered.
  Future<void> _checkDelivery() async {
    if (_checking) return;
    final open = _uploads
        .where((u) => u.id != null && u.state == _State.sent && !u.delivered)
        .toList();
    if (open.isEmpty) return;
    _checking = true;
    try {
      // The timeout matters: a socket the OS killed while idle can hang
      // without ever erroring, which would block every later check.
      final rows = await sb
          .from('photos')
          .select('id, delivered_at, status')
          .inFilter('id', [for (final u in open) u.id!])
          .timeout(const Duration(seconds: 8));
      final byId = {for (final r in rows) r['id'] as String: r};
      var changed = false;
      for (final u in open) {
        final r = byId[u.id];
        if (r == null) continue;
        final delivered = r['delivered_at'] != null || r['status'] != 'pending';
        if (delivered != u.delivered) {
          u.delivered = delivered;
          changed = true;
        }
      }
      if (changed && mounted) {
        setState(() {});
        _persist();
      }
    } catch (_) {
      // Informational only; stay quiet if offline.
    } finally {
      _checking = false;
    }
  }

  void _persist() => _History.save(_uploads).catchError((_) {});

  Future<void> _upload(_Upload u) async {
    setState(() {
      u.state = _State.uploading;
      u.error = null;
    });
    try {
      final uid = sb.auth.currentUser!.id;
      // Edited photos are always JPEG.
      final path = u.storagePath ??=
          '$uid/${DateTime.now().microsecondsSinceEpoch}.jpg';
      _persist();
      await sb.storage
          .from('photos')
          .uploadBinary(
            path,
            await PhotoStore.read(u.key),
            fileOptions: const FileOptions(
              upsert: true,
              contentType: 'image/jpeg',
            ),
          );
      final row = await sb
          .from('photos')
          .insert({'storage_path': path})
          .select('id')
          .single();
      u.id = row['id'] as String;
      if (mounted) setState(() => u.state = _State.sent);
      _persist();
      _checkDelivery();
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
    final Uint8List original;
    try {
      original = await f.readAsBytes();
    } catch (_) {
      return;
    }
    if (!mounted) return;
    final edited = await Navigator.of(context).push<Uint8List>(
      MaterialPageRoute(builder: (_) => EditPhotoPage(bytes: original)),
    );
    if (edited == null) return; // cancelled
    final u = _Upload(await PhotoStore.add(edited));
    if (!mounted) return;
    setState(() => _uploads.insert(0, u));
    _persist();
    await _upload(u);
  }

  /// Empties the list on this phone. Nothing is deleted from the account or the
  /// desktop inbox; photos still being sent stay until they finish.
  Future<void> _clear() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear the list?'),
        content: const Text(
          'This only removes the list from this device. Photos already sent '
          'stay in your desktop inbox. Photos that failed to send are '
          'discarded.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final gone = _uploads.where((u) => u.state != _State.uploading).toList();
    setState(() => _uploads.removeWhere(gone.contains));
    for (final u in gone) {
      PhotoStore.remove(u.key);
    }
    _persist();
  }

  void _showHelp() {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.document_scanner_outlined, size: 36),
        title: const Text(_helpTitle, textAlign: TextAlign.center),
        content: Text(
          _helpText,
          style: Theme.of(ctx).textTheme.bodyLarge?.copyWith(height: 1.5),
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Got it'),
          ),
        ],
      ),
    );
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

  /// Once the account is gone, the sent list and its photos on this phone go
  /// too.
  Future<void> _deleteAccount() => showDeleteAccountDialog(
    context,
    beforeSignOut: () async {
      for (final u in _uploads) {
        await PhotoStore.remove(u.key).catchError((_) {});
      }
      _uploads.clear();
      await PhotoStore.saveIndex([]);
    },
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final email = sb.auth.currentUser?.email ?? '';
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Row(
              children: [
                if (_uploads.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TextButton.icon(
                      onPressed: _clear,
                      icon: const Icon(Icons.clear_all),
                      label: const Text('Clear list'),
                    ),
                  ),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.help_outline),
                  tooltip: 'How it works',
                  onPressed: _showHelp,
                ),
                PopupMenuButton<String>(
                  icon: const Icon(Icons.account_circle_outlined),
                  tooltip: 'Account',
                  onSelected: (v) =>
                      v == 'delete' ? _deleteAccount() : _signOut(),
                  itemBuilder: (_) => [
                    PopupMenuItem(enabled: false, child: Text(email)),
                    const PopupMenuItem(value: 'out', child: Text('Sign out')),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text(
                        'Delete account…',
                        style: TextStyle(color: theme.colorScheme.error),
                      ),
                    ),
                  ],
                ),
              ],
            ),
            Expanded(
              child: _uploads.isEmpty
                  ? Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 320),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                Icons.document_scanner_outlined,
                                size: 72,
                                color: theme.colorScheme.outline,
                              ),
                              const SizedBox(height: 20),
                              Text(
                                _helpTitle,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.titleLarge,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                _helpText,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.bodyLarge?.copyWith(
                                  height: 1.5,
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      itemCount: _uploads.length,
                      itemBuilder: (_, i) => _uploadTile(_uploads[i], theme),
                    ),
            ),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
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
      child: Image(
        image: ResizeImage(PhotoStore.image(u.key), width: 96),
        width: 48,
        height: 48,
        fit: BoxFit.cover,
      ),
    ),
    title: Text(switch (u.state) {
      _State.uploading => 'Sending…',
      _State.sent =>
        u.delivered
            ? 'Delivered to desktop'
            : 'Uploaded · waiting for desktop',
      _State.failed => 'Failed to send',
    }),
    subtitle: u.error == null ? null : Text(u.error!),
    trailing: switch (u.state) {
      _State.uploading => const SizedBox(
        width: 24,
        height: 24,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
      _State.sent => Icon(
        u.delivered ? Icons.done_all : Icons.check_circle_outline,
        color: theme.colorScheme.primary,
      ),
      _State.failed => TextButton(
        onPressed: () => _upload(u),
        child: const Text('Retry'),
      ),
    },
  );
}
