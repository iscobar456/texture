import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'auth_errors.dart';
import 'supabase.dart';
import 'widgets.dart';

/// Must match PHOTO_BUCKET / FILES_BUCKET in packages/api.
const _buckets = ['photos', 'project-files'];

/// Every file key under [folder], at any depth. Storage lists one level at a
/// time, 100 entries per page; folders are the entries without an id.
Future<List<String>> _listTree(String bucket, String folder) async {
  final out = <String>[];
  for (var offset = 0; ; offset += 100) {
    final page = await sb.storage
        .from(bucket)
        .list(
          path: folder,
          searchOptions: SearchOptions(limit: 100, offset: offset),
        );
    for (final e in page) {
      final key = '$folder/${e.name}';
      if (e.id != null) {
        out.add(key);
      } else {
        out.addAll(await _listTree(bucket, key));
      }
    }
    if (page.length < 100) return out;
  }
}

/// Deletes the signed-in account on the server, the same way as
/// `deleteAccount` in packages/api: every stored file, then the
/// `delete_account` RPC (migration 0011), which refuses while files remain and
/// deletes the auth user (cascading to every table). Safe to call again after
/// a failure part way.
Future<void> _deleteServerData() async {
  final uid = sb.auth.currentUser?.id;
  if (uid == null) throw StateError('Not signed in');
  for (final bucket in _buckets) {
    final files = await _listTree(bucket, uid);
    for (var i = 0; i < files.length; i += 100) {
      await sb.storage
          .from(bucket)
          .remove(files.sublist(i, (i + 100).clamp(0, files.length)));
    }
  }
  await sb.rpc('delete_account');
}

/// Asks for the password, then deletes the account. Returns true once it is
/// gone. [beforeSignOut] runs after the server deletion succeeded and before
/// the local sign-out, so the caller can drop what this device kept.
Future<bool> showDeleteAccountDialog(
  BuildContext context, {
  required Future<void> Function() beforeSignOut,
}) async =>
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _DeleteAccountDialog(beforeSignOut: beforeSignOut),
    ) ==
    true;

class _DeleteAccountDialog extends StatefulWidget {
  const _DeleteAccountDialog({required this.beforeSignOut});
  final Future<void> Function() beforeSignOut;

  @override
  State<_DeleteAccountDialog> createState() => _DeleteAccountDialogState();
}

class _DeleteAccountDialogState extends State<_DeleteAccountDialog> {
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    final email = sb.auth.currentUser?.email;
    if (_busy || email == null || _password.text.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Re-checking the password keeps an unlocked phone from losing the
      // account to two taps.
      await sb.auth.signInWithPassword(email: email, password: _password.text);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is AuthException && e.code == 'invalid_credentials'
            ? 'Wrong password.'
            : friendlyError(e);
      });
      return;
    }
    try {
      await _deleteServerData();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is PostgrestException ? e.message : friendlyError(e);
      });
      return;
    }
    await widget.beforeSignOut().catchError((_) {});
    if (mounted) Navigator.pop(context, true);
    await sb.auth.signOut(scope: SignOutScope.local);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Delete account?'),
    content: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'This permanently deletes your Texture account and everything in '
            'it: documents, templates, photos and settings, on every device. '
            'It cannot be undone.',
          ),
          const SizedBox(height: 16),
          PasswordField(
            controller: _password,
            textInputAction: TextInputAction.done,
            onSubmitted: _busy ? null : _delete,
            onChanged: (_) => setState(() => _error = null),
          ),
          ErrorText(_error),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: _busy ? null : () => Navigator.pop(context, false),
        child: const Text('Cancel'),
      ),
      FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: Theme.of(context).colorScheme.error,
          foregroundColor: Theme.of(context).colorScheme.onError,
        ),
        onPressed: _busy ? null : _delete,
        child: _busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Text('Delete account'),
      ),
    ],
  );
}
