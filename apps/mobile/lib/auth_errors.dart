import 'dart:async';
import 'dart:io';

import 'package:supabase_flutter/supabase_flutter.dart';

/// True when [e] means the account exists but its email link has not been clicked yet.
bool isUnconfirmed(Object e) =>
    e is AuthException &&
    (e.code == 'email_not_confirmed' || e.message == 'Email not confirmed');

String friendlyError(Object e) {
  if (e is AuthRetryableFetchException ||
      e is SocketException ||
      e is TimeoutException) {
    return 'Can\'t reach the server. Check your connection and try again.';
  }
  if (e is AuthException) {
    switch (e.code) {
      case 'invalid_credentials':
        return 'Wrong email or password.';
      case 'email_not_confirmed':
        return 'Confirm your email first. Check your inbox for the link.';
      case 'weak_password':
        return 'That password is too weak. Try a longer or less common one.';
      case 'over_email_send_rate_limit':
        return 'Too many emails sent recently. Wait up to an hour before requesting another.';
      case 'over_request_rate_limit':
        return 'Too many attempts. Wait a minute and try again.';
      case 'same_password':
        return 'Choose a password different from your current one.';
      case 'user_already_exists':
      case 'email_exists':
        return 'An account with this email already exists. Try signing in.';
    }
    if (e.message == 'Invalid login credentials')
      return 'Wrong email or password.';
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}

final _emailRe = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
bool looksLikeEmail(String s) => _emailRe.hasMatch(s);
