import 'package:flutter/material.dart';

/// The indigo from the middle of the app icon's gradient (assets/icon.svg), a
/// little muted: a large flat button looks brighter than the icon does.
const _brand = Color(0xFF4C4AB8);

/// Corner radius shared by fields and buttons.
const _radius = BorderRadius.all(Radius.circular(12));

ThemeData textureTheme(Brightness brightness) {
  var scheme = ColorScheme.fromSeed(seedColor: _brand, brightness: brightness);
  scheme = brightness == Brightness.light
      ? scheme.copyWith(primary: _brand, onPrimary: Colors.white)
      // `primary` colors links, icons and focused fields, where the brand color
      // is too dim on a dark surface, so those get a lighter step of it. The
      // surfaces are neutral grays: the seeded ones are near black with a
      // purple tint.
      : scheme.copyWith(
          primary: const Color(0xFF969BE3),
          onPrimary: const Color(0xFF15143D),
          surface: const Color(0xFF1C1D20),
          surfaceDim: const Color(0xFF1C1D20),
          surfaceBright: const Color(0xFF3B3C40),
          surfaceContainerLowest: const Color(0xFF16171A),
          surfaceContainerLow: const Color(0xFF212225),
          surfaceContainer: const Color(0xFF25262A),
          surfaceContainerHigh: const Color(0xFF2D2E32),
          surfaceContainerHighest: const Color(0xFF37383C),
        );
  const shape = RoundedRectangleBorder(borderRadius: _radius);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    inputDecorationTheme: const InputDecorationThemeData(
      border: OutlineInputBorder(borderRadius: _radius),
    ),
    // Filled buttons are the brand color with white text in both modes.
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: _brand,
        foregroundColor: Colors.white,
        shape: shape,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(shape: shape),
    ),
  );
}
