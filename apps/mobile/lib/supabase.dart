import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:supabase_flutter/supabase_flutter.dart';

SupabaseClient get sb => Supabase.instance.client;

/// Where email links (confirm, reset) send the user back to the app. Each must be listed under
/// Authentication → URL Configuration → Redirect URLs in the Supabase dashboard. The phone one
/// must match the scheme in AndroidManifest.xml and ios/Runner/Info.plist; the web one is
/// wherever the web build is served from (the page's own address, without query or fragment).
String get authRedirect => kIsWeb
    ? '${Uri.base.origin}${Uri.base.path}'
    : 'dev.texture.mobile://login-callback/';

/// Where an email link has to be opened. Links use PKCE, whose secret stays in the app (or,
/// on the web, in this browser's storage), so another browser can't finish the sign-in.
const openLinkWhere = kIsWeb ? 'in this browser' : 'on this phone';

/// For new passwords. Keep in step with the desktop's check (`initAuth` in main.ts) and the
/// Supabase project's minimum (Authentication settings in the dashboard).
const minPasswordLength = 8;
