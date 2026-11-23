import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'auth_pages.dart';
import 'capture_page.dart';
import 'supabase.dart';

const _url = String.fromEnvironment('SUPABASE_URL');
const _anonKey = String.fromEnvironment('SUPABASE_ANON_KEY');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(url: _url, publishableKey: _anonKey);
  runApp(const TextureApp());
}

/// Indigo accents on neutral grays: the seeded dark surfaces are near black
/// with a purple tint.
final _darkScheme =
    ColorScheme.fromSeed(
      seedColor: Colors.indigo,
      brightness: Brightness.dark,
    ).copyWith(
      surface: const Color(0xFF1C1D20),
      surfaceDim: const Color(0xFF1C1D20),
      surfaceBright: const Color(0xFF3B3C40),
      surfaceContainerLowest: const Color(0xFF16171A),
      surfaceContainerLow: const Color(0xFF212225),
      surfaceContainer: const Color(0xFF25262A),
      surfaceContainerHigh: const Color(0xFF2D2E32),
      surfaceContainerHighest: const Color(0xFF37383C),
    );

final _navigatorKey = GlobalKey<NavigatorState>();

class TextureApp extends StatelessWidget {
  const TextureApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Texture',
    navigatorKey: _navigatorKey,
    theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
    darkTheme: ThemeData(colorScheme: _darkScheme, useMaterial3: true),
    themeMode: ThemeMode.system,
    home: const _AuthGate(),
  );
}

/// Swaps sign-in and capture on auth changes, and reacts to email links (confirm, reset).
class _AuthGate extends StatefulWidget {
  const _AuthGate();

  @override
  State<_AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<_AuthGate> {
  @override
  void initState() {
    super.initState();
    sb.auth.onAuthStateChange.listen((s) {
      final nav = _navigatorKey.currentState;
      if (nav == null) return;
      if (s.event == AuthChangeEvent.passwordRecovery) {
        nav.popUntil((r) => r.isFirst);
        nav.push(MaterialPageRoute(builder: (_) => const SetNewPasswordPage()));
      } else if (s.event == AuthChangeEvent.signedIn) {
        // Drop sign-up / check-email screens still stacked above after a confirmation link.
        nav.popUntil((r) => r.isFirst);
      }
    });
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<AuthState>(
    stream: sb.auth.onAuthStateChange,
    builder: (_, _) => sb.auth.currentSession == null
        ? const SignInPage()
        : const CapturePage(),
  );
}
