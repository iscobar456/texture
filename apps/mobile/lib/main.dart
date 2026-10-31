import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

const _url = String.fromEnvironment('SUPABASE_URL');
const _anonKey = String.fromEnvironment('SUPABASE_ANON_KEY');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(url: _url, publishableKey: _anonKey);
  runApp(const HwscanApp());
}

SupabaseClient get _sb => Supabase.instance.client;

class HwscanApp extends StatelessWidget {
  const HwscanApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'hwscan',
        theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
        home: StreamBuilder<AuthState>(
          stream: _sb.auth.onAuthStateChange,
          builder: (_, _) =>
              _sb.auth.currentSession == null ? const SignInPage() : const CapturePage(),
        ),
      );
}

class SignInPage extends StatefulWidget {
  const SignInPage({super.key});

  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  String? _error;

  Future<void> _submit({required bool signUp}) async {
    try {
      final email = _email.text.trim(), password = _password.text;
      if (signUp) {
        await _sb.auth.signUp(email: email, password: password);
      } else {
        await _sb.auth.signInWithPassword(email: email, password: password);
      }
    } on AuthException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('hwscan')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(children: [
            TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email')),
            TextField(
                controller: _password,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Password')),
            if (_error != null) Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 16),
            FilledButton(onPressed: () => _submit(signUp: false), child: const Text('Sign in')),
            TextButton(onPressed: () => _submit(signUp: true), child: const Text('Create account')),
          ]),
        ),
      );
}

class CapturePage extends StatefulWidget {
  const CapturePage({super.key});

  @override
  State<CapturePage> createState() => _CapturePageState();
}

class _CapturePageState extends State<CapturePage> {
  final _picker = ImagePicker();
  bool _busy = false;

  Future<void> _upload(XFile file) async {
    setState(() => _busy = true);
    try {
      final uid = _sb.auth.currentUser!.id;
      final ext = file.path.split('.').last;
      final path = '$uid/${DateTime.now().microsecondsSinceEpoch}.$ext';
      await _sb.storage.from('photos').upload(path, File(file.path));
      await _sb.from('photos').insert({'storage_path': path});
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Sent to desktop inbox')));
      }
    } on Exception catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick(ImageSource source) async {
    final f = await _picker.pickImage(source: source);
    if (f != null) await _upload(f);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('hwscan'), actions: [
          IconButton(onPressed: _sb.auth.signOut, icon: const Icon(Icons.logout)),
        ]),
        body: Center(
          child: _busy
              ? const CircularProgressIndicator()
              : Column(mainAxisSize: MainAxisSize.min, children: [
                  FilledButton.icon(
                      onPressed: () => _pick(ImageSource.camera),
                      icon: const Icon(Icons.photo_camera),
                      label: const Text('Take photo')),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                      onPressed: () => _pick(ImageSource.gallery),
                      icon: const Icon(Icons.photo_library),
                      label: const Text('Choose from gallery')),
                ]),
        ),
      );
}
