import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'auth_errors.dart';
import 'supabase.dart';
import 'widgets.dart';

class SignInPage extends StatefulWidget {
  const SignInPage({super.key});

  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  String? _error; // from the server; field problems are shown on the fields
  String? _emailError;
  String? _passwordError;
  bool _busy = false;
  bool _unconfirmed = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final email = _email.text.trim(), password = _password.text;
    setState(() {
      _emailError = looksLikeEmail(email)
          ? null
          : 'Enter a valid email address.';
      _passwordError = password.isEmpty ? 'Enter your password.' : null;
      _error = null;
      _unconfirmed = false;
    });
    if (_emailError != null || _passwordError != null) return;
    setState(() => _busy = true);
    try {
      await sb.auth.signInWithPassword(email: email, password: password);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = friendlyError(e);
          _unconfirmed = isUnconfirmed(e);
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _push(Widget page) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));

  @override
  Widget build(BuildContext context) => FormScaffold(
    picture: Image.asset(
      'assets/icon.png',
      width: 80,
      height: 80,
      filterQuality: FilterQuality.medium,
      excludeFromSemantics: true,
    ),
    heading: 'Welcome to Texture',
    subtitle: 'Sign in to send photos to Texture on your computer.',
    children: [
      EmailField(
        controller: _email,
        errorText: _emailError,
        onChanged: (_) => setState(() {
          _emailError = null;
          _error = null;
          _unconfirmed = false;
        }),
      ),
      const SizedBox(height: fieldGap),
      PasswordField(
        controller: _password,
        textInputAction: TextInputAction.done,
        onSubmitted: _submit,
        errorText: _passwordError,
        onChanged: (_) => setState(() {
          _passwordError = null;
          _error = null;
          _unconfirmed = false;
        }),
      ),
      Align(
        alignment: Alignment.centerRight,
        child: TextButton(
          onPressed: () =>
              _push(ForgotPasswordPage(initialEmail: _email.text.trim())),
          child: const Text('Forgot password?'),
        ),
      ),
      ErrorText(_error),
      if (_unconfirmed)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => _push(CheckEmailPage(email: _email.text.trim())),
            child: const Text('Resend confirmation email'),
          ),
        ),
      const SizedBox(height: fieldGap),
      LoadingButton(label: 'Sign in', onPressed: _submit, busy: _busy),
      const SizedBox(height: 24),
      Wrap(
        alignment: WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          const Text('New to Texture?'),
          TextButton(
            onPressed: () => _push(const SignUpPage()),
            child: const Text('Create account'),
          ),
        ],
      ),
    ],
  );
}

class SignUpPage extends StatefulWidget {
  const SignUpPage({super.key});

  @override
  State<SignUpPage> createState() => _SignUpPageState();
}

class _SignUpPageState extends State<SignUpPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  bool _submitted = false;
  String? _emailError;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final emailOk = looksLikeEmail(_email.text.trim());
    setState(() {
      _submitted = true;
      _emailError = emailOk ? null : 'Enter a valid email address.';
      _error = null;
    });
    if (!emailOk || !NewPasswordFields.valid(_password.text, _confirm.text)) {
      return;
    }
    setState(() => _busy = true);
    final email = _email.text.trim();
    try {
      final res = await sb.auth.signUp(
        email: email,
        password: _password.text,
        emailRedirectTo: authRedirect,
      );
      if (!mounted) return;
      if (res.session != null) {
        // Signed in straight away; the auth stream swaps in the home page.
        Navigator.of(context).popUntil((r) => r.isFirst);
      } else {
        // Same outcome for a new and an already-registered address, by design: Supabase does not
        // reveal which emails have accounts, so neither can the app.
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(
            builder: (_) => CheckEmailPage(email: email, afterSignUp: true),
          ),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormScaffold(
    heading: 'Create account',
    subtitle: 'You\'ll use this on your computer too.',
    children: [
      EmailField(
        controller: _email,
        autofillHints: const [AutofillHints.newUsername, AutofillHints.email],
        errorText: _emailError,
        onChanged: (_) => setState(() {
          _emailError = null;
          _error = null;
        }),
      ),
      const SizedBox(height: fieldGap),
      NewPasswordFields(
        password: _password,
        confirm: _confirm,
        submitted: _submitted,
        onSubmitted: _submit,
        onChanged: () => setState(() => _error = null),
      ),
      ErrorText(_error),
      const SizedBox(height: 24),
      LoadingButton(label: 'Create account', onPressed: _submit, busy: _busy),
    ],
  );
}

/// Shown after sign-up (or when sign-in finds an unconfirmed account). Offers resend with a
/// cooldown. Wording is deliberately neutral about whether the account is new.
class CheckEmailPage extends StatefulWidget {
  const CheckEmailPage({
    super.key,
    required this.email,
    this.afterSignUp = false,
  });

  final String email;
  final bool afterSignUp;

  @override
  State<CheckEmailPage> createState() => _CheckEmailPageState();
}

class _CheckEmailPageState extends State<CheckEmailPage> {
  static const _cooldown = 30;
  Timer? _timer;
  int _wait = 0;
  bool _sending = false;
  String? _error;
  bool _sent = false;

  @override
  void initState() {
    super.initState();
    // A fresh sign-up has just sent mail; coming from sign-in, allow resending right away.
    if (widget.afterSignUp) _startCooldown();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startCooldown() {
    _wait = _cooldown;
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _wait--);
      if (_wait <= 0) t.cancel();
    });
  }

  Future<void> _resend() async {
    setState(() {
      _sending = true;
      _error = null;
      _sent = false;
    });
    try {
      await sb.auth.resend(
        type: OtpType.signup,
        email: widget.email,
        emailRedirectTo: authRedirect,
      );
      if (mounted) {
        setState(() => _sent = true);
        _startCooldown();
      }
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return FormScaffold(
      picture: Icon(
        Icons.mark_email_unread_outlined,
        size: 64,
        color: theme.colorScheme.primary,
      ),
      heading: 'Check your email',
      children: [
        Text(
          widget.afterSignUp
              ? 'We sent a link to ${widget.email}.'
              : 'Confirm ${widget.email} to finish setting up your account.',
          style: theme.textTheme.titleMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 12),
        Text(
          'Open it $openLinkWhere to confirm your address and sign in.\n\n'
          'Nothing arrived? Check spam, or if you already have an account with this email, '
          'go back and sign in or reset your password.',
          style: theme.textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
        if (_sent)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              'Email sent again.',
              textAlign: TextAlign.center,
              style: TextStyle(color: theme.colorScheme.primary),
            ),
          ),
        ErrorText(_error),
        const SizedBox(height: 24),
        LoadingButton(
          label: _wait > 0 ? 'Resend email (${_wait}s)' : 'Resend email',
          onPressed: _wait > 0 ? null : _resend,
          busy: _sending,
        ),
        TextButton(
          onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
          child: const Text('Back to sign in'),
        ),
      ],
    );
  }
}

class ForgotPasswordPage extends StatefulWidget {
  const ForgotPasswordPage({super.key, this.initialEmail = ''});
  final String initialEmail;

  @override
  State<ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends State<ForgotPasswordPage> {
  late final _email = TextEditingController(text: widget.initialEmail);
  bool _busy = false;
  bool _sent = false;
  String? _emailError;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final email = _email.text.trim();
    if (!looksLikeEmail(email)) {
      return setState(() => _emailError = 'Enter a valid email address.');
    }
    setState(() {
      _busy = true;
      _emailError = null;
      _error = null;
    });
    try {
      await sb.auth.resetPasswordForEmail(email, redirectTo: authRedirect);
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormScaffold(
    heading: 'Reset password',
    subtitle: _sent
        ? null
        : 'Enter your email and we\'ll send a link to choose a new password.',
    children: _sent
        ? [
            Text(
              'If ${_email.text.trim()} has an account, a reset link is on its way. '
              'Open it $openLinkWhere.',
              style: Theme.of(context).textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Back to sign in'),
            ),
          ]
        : [
            EmailField(
              controller: _email,
              textInputAction: TextInputAction.done,
              errorText: _emailError,
              onChanged: (_) => setState(() {
                _emailError = null;
                _error = null;
              }),
              onSubmitted: _submit,
            ),
            ErrorText(_error),
            const SizedBox(height: 24),
            LoadingButton(
              label: 'Send reset link',
              onPressed: _submit,
              busy: _busy,
            ),
          ],
  );
}

/// Opened when the user follows a reset link (auth event passwordRecovery).
class SetNewPasswordPage extends StatefulWidget {
  const SetNewPasswordPage({super.key});

  @override
  State<SetNewPasswordPage> createState() => _SetNewPasswordPageState();
}

class _SetNewPasswordPageState extends State<SetNewPasswordPage> {
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  bool _submitted = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _submitted = true;
      _error = null;
    });
    if (!NewPasswordFields.valid(_password.text, _confirm.text)) return;
    setState(() => _busy = true);
    try {
      await sb.auth.updateUser(UserAttributes(password: _password.text));
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Password updated')));
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormScaffold(
    heading: 'Choose a new password',
    children: [
      NewPasswordFields(
        password: _password,
        confirm: _confirm,
        submitted: _submitted,
        onSubmitted: _submit,
        onChanged: () => setState(() => _error = null),
        passwordLabel: 'New password',
        confirmLabel: 'Confirm new password',
      ),
      ErrorText(_error),
      const SizedBox(height: 24),
      LoadingButton(label: 'Update password', onPressed: _submit, busy: _busy),
    ],
  );
}
