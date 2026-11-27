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
import 'widgets.dart';

enum _State { uploading, sent, failed }

class _Upload {
  _Upload(
    this.key, {
    this.state = _State.uploading,
    this.id,
    this.delivered = false,
    this.storagePath,
    DateTime? at,
  }) : at = at ?? DateTime.now();
  final String key; // the edited photo in PhotoStore
  final DateTime at; // when it was added to the list
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
    'at': at.millisecondsSinceEpoch,
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
            at: _savedAt(m),
          ),
      ];
    } catch (_) {
      return [];
    }
  }

  /// Entries saved before `at` existed fall back to the time in the storage
  /// file name (`<uid>/<microseconds>.jpg`), or else to the epoch.
  static DateTime _savedAt(Map<String, dynamic> m) {
    final ms = m['at'];
    if (ms is int) return DateTime.fromMillisecondsSinceEpoch(ms);
    final name = (m['storagePath'] as String?)?.split('/').last ?? '';
    final us = int.tryParse(name.split('.').first);
    return us == null
        ? DateTime.fromMillisecondsSinceEpoch(0)
        : DateTime.fromMicrosecondsSinceEpoch(us);
  }

  static Future<void> save(List<_Upload> uploads) async {
    for (final u in uploads.skip(_keep)) {
      await PhotoStore.remove(u.key);
    }
    await PhotoStore.saveIndex([
      for (final u in uploads.take(_keep)) u.toJson(),
    ]);
  }
}

final _bigButton = FilledButton.styleFrom(
  minimumSize: const Size.fromHeight(64),
  textStyle: const TextStyle(fontSize: 18),
  iconSize: 28,
);

final _smallButton = OutlinedButton.styleFrom(
  minimumSize: const Size.fromHeight(52),
  textStyle: const TextStyle(fontSize: 16),
  iconSize: 22,
);

/// Row padding, shared by the header and the list so their edges line up.
const _gutter = 20.0;

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

class _CapturePageState extends State<CapturePage> with WidgetsBindingObserver {
  RealtimeChannel? _channel;
  Timer? _poll;
  Timer? _clock; // keeps the "N min ago" labels current
  bool _checking = false; // a delivery lookup is in flight
  final _picker = ImagePicker();
  final _uploads = <_Upload>[]; // newest first, persisted by _History

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _History.load()
        .then((saved) {
          if (!mounted) return;
          // Anything added while loading stays on top.
          setState(() => _uploads.addAll(saved));
          _checkDelivery();
        })
        .catchError((_) {});
    // Realtime alone is not dependable on a phone (the socket can stall or drop
    // without notice), so while a sent photo is not yet delivered, also ask now
    // and then. A cheap query that stops by itself once everything is delivered.
    // Not gated on lifecycle state: timers don't fire while the app is
    // suspended anyway, and an `inactive`/`hidden` event with no `resumed`
    // after it used to switch polling off for good.
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _checkDelivery());
    _clock = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted && _uploads.isNotEmpty) setState(() {});
    });
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
    _clock?.cancel();
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
            Padding(
              padding: const EdgeInsets.fromLTRB(_gutter, 16, 4, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Sent photos',
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                  if (_uploads.isNotEmpty)
                    IconButton(
                      icon: const Icon(Icons.delete_sweep_outlined),
                      tooltip: 'Clear list',
                      onPressed: _clear,
                    ),
                  IconButton(
                    icon: const Icon(Icons.help_outline),
                    tooltip: 'How it works',
                    onPressed: _showHelp,
                  ),
                  PopupMenuButton<String>(
                    icon: const Icon(Icons.account_circle_outlined),
                    tooltip: 'Account',
                    onSelected: (v) => switch (v) {
                      'delete' => _deleteAccount(),
                      'privacy' => openLink(context, privacyUrl),
                      _ => _signOut(),
                    },
                    itemBuilder: (_) => [
                      PopupMenuItem(enabled: false, child: Text(email)),
                      const PopupMenuItem(
                        value: 'privacy',
                        child: Text('Privacy policy'),
                      ),
                      const PopupMenuItem(
                        value: 'out',
                        child: Text('Sign out'),
                      ),
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
            ),
            Divider(
              height: 1,
              thickness: 1,
              color: theme.colorScheme.outlineVariant,
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
                  // Rows fade out above the buttons instead of ending at a
                  // hard edge.
                  : ShaderMask(
                      shaderCallback: (r) => const LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Colors.black, Colors.transparent],
                        stops: [0.94, 1],
                      ).createShader(r),
                      blendMode: BlendMode.dstIn,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(
                          _gutter,
                          16,
                          _gutter,
                          24,
                        ),
                        itemCount: _uploads.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 12),
                        itemBuilder: (_, i) => _uploadTile(_uploads[i], theme),
                      ),
                    ),
            ),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
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
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        style: _smallButton,
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

  /// "Just now", "5 min ago", "Today 14:03", "Yesterday 09:12", "Nov 3, 14:03".
  String _when(DateTime t) {
    if (t.millisecondsSinceEpoch == 0) return '';
    final loc = MaterialLocalizations.of(context);
    final now = DateTime.now();
    final ago = now.difference(t);
    if (ago.inMinutes < 1) return 'Just now';
    if (ago.inMinutes < 60) return '${ago.inMinutes} min ago';
    final time = loc.formatTimeOfDay(
      TimeOfDay.fromDateTime(t),
      alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
    );
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(t.year, t.month, t.day);
    final days = today.difference(day).inDays;
    if (days == 0) return 'Today $time';
    if (days == 1) return 'Yesterday $time';
    return '${loc.formatShortMonthDay(t)}, $time';
  }

  void _preview(_Upload u) {
    showDialog<void>(
      context: context,
      barrierColor: Colors.black87,
      builder: (ctx) => GestureDetector(
        onTap: () => Navigator.pop(ctx),
        child: InteractiveViewer(
          maxScale: 5,
          child: Center(child: Image(image: PhotoStore.image(u.key))),
        ),
      ),
    );
  }

  Widget _uploadTile(_Upload u, ThemeData theme) {
    final scheme = theme.colorScheme;
    final failed = u.state == _State.failed;
    // Delivered rows step back so anything still in progress stands out.
    final done = u.state == _State.sent && u.delivered;
    final when = _when(u.at);
    return Row(
      children: [
        Opacity(
          opacity: done ? 0.7 : 1,
          child: Material(
            clipBehavior: Clip.antiAlias,
            borderRadius: BorderRadius.circular(8),
            child: Ink.image(
              image: ResizeImage(PhotoStore.image(u.key), width: 192),
              width: 64,
              height: 64,
              fit: BoxFit.cover,
              child: InkWell(
                onTap: () => _preview(u),
                child: Semantics(label: 'View photo'),
              ),
            ),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                switch (u.state) {
                  _State.uploading => 'Sending…',
                  _State.sent => u.delivered ? 'Delivered' : 'Sent',
                  _State.failed => 'Failed',
                },
                style: theme.textTheme.titleMedium?.copyWith(
                  color: failed
                      ? scheme.error
                      : done
                      ? scheme.onSurfaceVariant
                      : scheme.onSurface,
                ),
              ),
              if (failed && u.error != null)
                Text(
                  u.error!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                )
              else if (when.isNotEmpty)
                Text(
                  u.state == _State.sent && !u.delivered
                      ? '$when · waiting for desktop'
                      : when,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        switch (u.state) {
          _State.uploading => const SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          _State.sent => Icon(
            u.delivered ? Icons.done_all : Icons.check_circle_outline,
            color: done ? scheme.onSurfaceVariant : scheme.primary,
          ),
          _State.failed => TextButton.icon(
            onPressed: () => _upload(u),
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        },
      ],
    );
  }
}
