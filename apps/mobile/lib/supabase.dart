import 'package:supabase_flutter/supabase_flutter.dart';

SupabaseClient get sb => Supabase.instance.client;

/// Where email links (confirm, reset) send the user back to the app. Must be listed under
/// Authentication → URL Configuration → Redirect URLs in the Supabase dashboard, and match the
/// scheme in AndroidManifest.xml and ios/Runner/Info.plist.
const authRedirect = 'dev.texture.mobile://login-callback/';

/// Supabase's default minimum; raise it here if the project setting is raised.
const minPasswordLength = 6;
