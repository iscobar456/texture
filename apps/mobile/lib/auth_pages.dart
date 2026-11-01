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
  String? _error;
  bool _busy = false;
  bool _unconfirmed = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _email.text.trim(), password = _password.text;
    if (!looksLikeEmail(email))
      return setState(() => _error = 'Enter a valid email address.');
    if (password.isEmpty)
      return setState(() => _error = 'Enter your password.');
    setState(() {
      _busy = true;
      _error = null;
      _unconfirmed = false;
    });
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
    topPadding: 72,
    children: [
      Text(
        'Welcome to Texture',
        style: Theme.of(context).textTheme.headlineSmall,
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 8),
      Text(
        'Sign in with the same account you use in the Texture desktop app '
        'so your photos arrive in its inbox.',
        style: Theme.of(context).textTheme.bodyMedium,
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 32),
      TextField(
        controller: _email,
        keyboardType: TextInputType.emailAddress,
        textInputAction: TextInputAction.next,
        autofillHints: const [AutofillHints.email],
        decoration: const InputDecoration(labelText: 'Email'),
      ),
      PasswordField(
        controller: _password,
        textInputAction: TextInputAction.done,
        onSubmitted: _submit,
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
      const SizedBox(height: 16),
      LoadingButton(label: 'Sign in', onPressed: _submit, busy: _busy),
      TextButton(
        onPressed: () =>
            _push(ForgotPasswordPage(initialEmail: _email.text.trim())),
        child: const Text('Forgot password?'),
      ),
      TextButton(
        onPressed: () => _push(const SignUpPage()),
        child: const Text('Create account'),
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
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  String? get _emailError {
    final v = _email.text.trim();
    return _submitted && !looksLikeEmail(v)
        ? 'Enter a valid email address.'
        : null;
  }

  String? get _passwordError =>
      _submitted && _password.text.length < minPasswordLength
      ? 'Use at least $minPasswordLength characters.'
      : null;

  // Shown as soon as the user has typed in the confirm field, not only after submit.
  String? get _confirmError =>
      (_submitted || _confirm.text.isNotEmpty) &&
          _confirm.text != _password.text
      ? 'Passwords do not match.'
      : null;

  Future<void> _submit() async {
    setState(() => _submitted = true);
    if (_emailError != null || _passwordError != null || _confirmError != null)
      return;
    setState(() {
      _busy = true;
      _error = null;
    });
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
    title: 'Create account',
    children: [
      TextField(
        controller: _email,
        keyboardType: TextInputType.emailAddress,
        textInputAction: TextInputAction.next,
        autofillHints: const [AutofillHints.newUsername, AutofillHints.email],
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(labelText: 'Email', errorText: _emailError),
      ),
      PasswordField(
        controller: _password,
        autofillHints: const [AutofillHints.newPassword],
        errorText: _passwordError,
        onChanged: (_) => setState(() {}),
      ),
      PasswordField(
        controller: _confirm,
        label: 'Confirm password',
        autofillHints: const [AutofillHints.newPassword],
        textInputAction: TextInputAction.done,
        onSubmitted: _submit,
        errorText: _confirmError,
        onChanged: (_) => setState(() {}),
      ),
      ErrorText(_error),
      const SizedBox(height: 16),
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
      title: 'Check your email',
      topPadding: 48,
      children: [
        Icon(
          Icons.mark_email_unread_outlined,
          size: 64,
          color: theme.colorScheme.primary,
        ),
        const SizedBox(height: 24),
        Text(
          widget.afterSignUp
              ? 'We sent a link to ${widget.email}.'
              : 'Confirm ${widget.email} to finish setting up your account.',
          style: theme.textTheme.titleMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 12),
        Text(
          'Open it on this phone to confirm your address and sign in.\n\n'
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
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _email.text.trim();
    if (!looksLikeEmail(email))
      return setState(() => _error = 'Enter a valid email address.');
    setState(() {
      _busy = true;
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
    title: 'Reset password',
    children: _sent
        ? [
            const SizedBox(height: 24),
            Text(
              'If ${_email.text.trim()} has an account, a reset link is on its way. '
              'Open it on this phone.',
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
            const Text(
              'Enter your email and we\'ll send a link to choose a new password.',
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.email],
              onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(labelText: 'Email'),
            ),
            ErrorText(_error),
            const SizedBox(height: 16),
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
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_password.text.length < minPasswordLength) {
      return setState(
        () => _error = 'Use at least $minPasswordLength characters.',
      );
    }
    if (_password.text != _confirm.text)
      return setState(() => _error = 'Passwords do not match.');
    setState(() {
      _busy = true;
      _error = null;
    });
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
    title: 'Choose a new password',
    children: [
      PasswordField(
        controller: _password,
        label: 'New password',
        autofillHints: const [AutofillHints.newPassword],
      ),
      PasswordField(
        controller: _confirm,
        label: 'Confirm new password',
        autofillHints: const [AutofillHints.newPassword],
        textInputAction: TextInputAction.done,
        onSubmitted: _submit,
      ),
      ErrorText(_error),
      const SizedBox(height: 16),
      LoadingButton(label: 'Update password', onPressed: _submit, busy: _busy),
    ],
  );
}
