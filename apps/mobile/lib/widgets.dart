import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'supabase.dart';

/// Space between stacked form fields.
const fieldGap = 16.0;

/// Filled button that shows a spinner and ignores taps while [busy].
class LoadingButton extends StatelessWidget {
  const LoadingButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.busy = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: double.infinity,
    height: 52,
    child: FilledButton(
      onPressed: busy ? null : onPressed,
      child: busy
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Text(label),
    ),
  );
}

class EmailField extends StatelessWidget {
  const EmailField({
    super.key,
    required this.controller,
    this.errorText,
    this.onChanged,
    this.onSubmitted,
    this.textInputAction = TextInputAction.next,
    this.autofillHints = const [AutofillHints.email],
  });

  final TextEditingController controller;
  final String? errorText;
  final ValueChanged<String>? onChanged;
  final VoidCallback? onSubmitted;
  final TextInputAction textInputAction;
  final Iterable<String> autofillHints;

  @override
  Widget build(BuildContext context) => TextField(
    controller: controller,
    keyboardType: TextInputType.emailAddress,
    autocorrect: false,
    enableSuggestions: false,
    textInputAction: textInputAction,
    autofillHints: autofillHints,
    onChanged: onChanged,
    onSubmitted: onSubmitted == null ? null : (_) => onSubmitted!(),
    decoration: InputDecoration(labelText: 'Email', errorText: errorText),
  );
}

class PasswordField extends StatefulWidget {
  const PasswordField({
    super.key,
    required this.controller,
    this.label = 'Password',
    this.textInputAction = TextInputAction.next,
    this.onSubmitted,
    this.autofillHints = const [AutofillHints.password],
    this.errorText,
    this.helperText,
    this.onChanged,
    this.focusNode,
  });

  final TextEditingController controller;
  final String label;
  final TextInputAction textInputAction;
  final VoidCallback? onSubmitted;
  final Iterable<String> autofillHints;
  final String? errorText;
  final String? helperText;
  final ValueChanged<String>? onChanged;
  final FocusNode? focusNode;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _hidden = true;

  @override
  Widget build(BuildContext context) => TextField(
    controller: widget.controller,
    focusNode: widget.focusNode,
    obscureText: _hidden,
    autofillHints: widget.autofillHints,
    textInputAction: widget.textInputAction,
    onSubmitted: widget.onSubmitted == null
        ? null
        : (_) => widget.onSubmitted!(),
    onChanged: widget.onChanged,
    decoration: InputDecoration(
      labelText: widget.label,
      errorText: widget.errorText,
      helperText: widget.helperText,
      // Otherwise the keyboard's "Next" lands on this button instead of the
      // field below.
      suffixIcon: ExcludeFocusTraversal(
        child: IconButton(
          tooltip: _hidden ? 'Show password' : 'Hide password',
          icon: Icon(_hidden ? Icons.visibility : Icons.visibility_off),
          onPressed: () => setState(() => _hidden = !_hidden),
        ),
      ),
    ),
  );
}

/// A new password and its confirmation. The length rule shows from the start;
/// a mismatch waits until the user leaves the second field (or submits), then
/// clears as soon as the two match.
class NewPasswordFields extends StatefulWidget {
  const NewPasswordFields({
    super.key,
    required this.password,
    required this.confirm,
    required this.submitted,
    required this.onSubmitted,
    this.onChanged,
    this.passwordLabel = 'Password',
    this.confirmLabel = 'Confirm password',
  });

  final TextEditingController password;
  final TextEditingController confirm;
  final bool submitted;
  final VoidCallback onSubmitted;
  final VoidCallback? onChanged;
  final String passwordLabel;
  final String confirmLabel;

  static bool valid(String password, String confirm) =>
      password.length >= minPasswordLength && password == confirm;

  @override
  State<NewPasswordFields> createState() => _NewPasswordFieldsState();
}

class _NewPasswordFieldsState extends State<NewPasswordFields> {
  final _confirmFocus = FocusNode();
  bool _leftConfirm = false;

  @override
  void initState() {
    super.initState();
    _confirmFocus.addListener(() {
      if (!_confirmFocus.hasFocus && widget.confirm.text.isNotEmpty) {
        setState(() => _leftConfirm = true);
      }
    });
  }

  @override
  void dispose() {
    _confirmFocus.dispose();
    super.dispose();
  }

  void _changed(String _) {
    setState(() {});
    widget.onChanged?.call();
  }

  @override
  Widget build(BuildContext context) {
    final password = widget.password.text, confirm = widget.confirm.text;
    final tooShort = widget.submitted && password.length < minPasswordLength;
    final mismatch = (widget.submitted || _leftConfirm) && password != confirm;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PasswordField(
          controller: widget.password,
          label: widget.passwordLabel,
          autofillHints: const [AutofillHints.newPassword],
          helperText: 'At least $minPasswordLength characters',
          errorText: tooShort
              ? 'Use at least $minPasswordLength characters.'
              : null,
          onChanged: _changed,
        ),
        const SizedBox(height: fieldGap),
        PasswordField(
          controller: widget.confirm,
          focusNode: _confirmFocus,
          label: widget.confirmLabel,
          autofillHints: const [AutofillHints.newPassword],
          textInputAction: TextInputAction.done,
          onSubmitted: widget.onSubmitted,
          errorText: mismatch ? 'Passwords do not match.' : null,
          onChanged: _changed,
        ),
      ],
    );
  }
}

class ErrorText extends StatelessWidget {
  const ErrorText(this.message, {super.key});
  final String? message;

  @override
  Widget build(BuildContext context) => message == null
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text(
            message!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        );
}

/// The layout shared by the signed-out screens: an optional picture, a heading
/// and the form, in a narrow column that scrolls so the keyboard never covers
/// it.
class FormScaffold extends StatelessWidget {
  const FormScaffold({
    super.key,
    required this.heading,
    this.subtitle,
    this.picture,
    required this.children,
  });

  final String heading;
  final String? subtitle;
  final Widget? picture;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      // Just the back arrow, on pages that have somewhere to go back to.
      appBar: Navigator.of(context).canPop() ? AppBar() : null,
      body: SafeArea(
        child: Align(
          // A little above the middle.
          alignment: const Alignment(0, -0.3),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (picture != null) ...[
                      Center(child: picture),
                      const SizedBox(height: 24),
                    ],
                    Text(
                      heading,
                      style: theme.textTheme.headlineSmall,
                      textAlign: TextAlign.center,
                    ),
                    if (subtitle != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        subtitle!,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ],
                    const SizedBox(height: 32),
                    ...children,
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Opens a web page in the browser. Says so if no browser could take it.
Future<void> openLink(BuildContext context, String url) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final ok = await launchUrl(
    Uri.parse(url),
    mode: LaunchMode.externalApplication,
  ).catchError((_) => false);
  if (!ok) {
    messenger?.showSnackBar(SnackBar(content: Text('Couldn\'t open $url')));
  }
}

/// Links to the terms and privacy policy, for the bottom of the auth screens. With [agree],
/// worded as the agreement that creating an account implies.
class LegalLinks extends StatelessWidget {
  const LegalLinks({super.key, this.agree = false});
  final bool agree;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    Widget link(String label, String url) => TextButton(
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        minimumSize: const Size(0, 36),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        textStyle: style,
      ),
      onPressed: () => openLink(context, url),
      child: Text(label),
    );
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (agree)
          Text('By creating an account you agree to the', style: style),
        link('Terms of Use', termsUrl),
        Text(agree ? 'and' : '·', style: style),
        link('Privacy Policy', privacyUrl),
      ],
    );
  }
}
