import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

/// Longest side after editing. Plenty for LaTeX figures and OCR (the desktop
/// downsizes to 1568px for OCR) while keeping uploads and decoding quick.
const _maxSide = 3000;

class _Prepared {
  _Prepared(this.path, this.width, this.height);
  final String path;
  final int width;
  final int height;
}

/// Bakes EXIF orientation into the pixels and caps the size, so the preview
/// and the final crop agree on what "up" is.
Future<_Prepared> _prepare(String src) => compute(_prepareSync, src);

_Prepared _prepareSync(String src) {
  var im = img.decodeImage(File(src).readAsBytesSync());
  if (im == null) throw const FormatException('Could not read this image.');
  im = img.bakeOrientation(im);
  if (math.max(im.width, im.height) > _maxSide) {
    im = im.width >= im.height
        ? img.copyResize(im, width: _maxSide)
        : img.copyResize(im, height: _maxSide);
  }
  final out = '${Directory.systemTemp.path}/texture_edit_src_'
      '${DateTime.now().microsecondsSinceEpoch}.jpg';
  File(out).writeAsBytesSync(img.encodeJpg(im, quality: 92));
  return _Prepared(out, im.width, im.height);
}

class _EditArgs {
  _EditArgs(this.path, this.turns, this.crop);
  final String path;
  final int turns;
  final Rect crop; // fractions of the rotated image
}

Future<String> _render(_EditArgs a) => compute(_renderSync, a);

String _renderSync(_EditArgs a) {
  var im = img.decodeImage(File(a.path).readAsBytesSync())!;
  if (a.turns % 4 != 0) im = img.copyRotate(im, angle: 90.0 * (a.turns % 4));
  final x = (a.crop.left * im.width).round().clamp(0, im.width - 1);
  final y = (a.crop.top * im.height).round().clamp(0, im.height - 1);
  final w = (a.crop.width * im.width).round().clamp(1, im.width - x);
  final h = (a.crop.height * im.height).round().clamp(1, im.height - y);
  if (w != im.width || h != im.height) {
    im = img.copyCrop(im, x: x, y: y, width: w, height: h);
  }
  final out = '${Directory.systemTemp.path}/texture_edit_out_'
      '${DateTime.now().microsecondsSinceEpoch}.jpg';
  File(out).writeAsBytesSync(img.encodeJpg(im, quality: 90));
  return out;
}

/// Rotate (90° steps) and crop a photo before it is uploaded. Pops with the
/// path of the edited JPEG, or null if cancelled.
class EditPhotoPage extends StatefulWidget {
  const EditPhotoPage({super.key, required this.path});
  final String path;

  @override
  State<EditPhotoPage> createState() => _EditPhotoPageState();
}

class _EditPhotoPageState extends State<EditPhotoPage> {
  _Prepared? _src;
  Object? _error;
  int _turns = 0;
  Rect _crop = const Rect.fromLTRB(0, 0, 1, 1);
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _prepare(widget.path).then((p) {
      if (mounted) setState(() => _src = p);
    }).catchError((Object e) {
      if (mounted) setState(() => _error = e);
    });
  }

  @override
  void dispose() {
    final s = _src;
    if (s != null) File(s.path).delete().catchError((_) => File(s.path));
    super.dispose();
  }

  void _rotate() {
    final c = _crop;
    setState(() {
      _turns = (_turns + 1) % 4;
      // Rotate the crop box with the image (90° clockwise).
      _crop = Rect.fromLTRB(1 - c.bottom, c.left, 1 - c.top, c.right);
    });
  }

  Future<void> _done() async {
    setState(() => _busy = true);
    try {
      final out = await _render(_EditArgs(_src!.path, _turns, _crop));
      if (mounted) Navigator.pop(context, out);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not process the photo.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final src = _src;
    final changed =
        _turns != 0 || _crop != const Rect.fromLTRB(0, 0, 1, 1);
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('Adjust photo'),
        actions: [
          TextButton(
            onPressed: src == null || _busy ? null : _done,
            child: const Text('Send'),
          ),
        ],
      ),
      body: _error != null
          ? Center(
              child: Text(
                'Could not open this photo.',
                style: const TextStyle(color: Colors.white),
              ),
            )
          : src == null || _busy
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Expanded(
                  child: _CropArea(
                    path: src.path,
                    aspect: _turns.isOdd
                        ? src.height / src.width
                        : src.width / src.height,
                    turns: _turns,
                    srcWide: src.width >= src.height,
                    crop: _crop,
                    onChanged: (r) => setState(() => _crop = r),
                  ),
                ),
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        TextButton.icon(
                          onPressed: _rotate,
                          icon: const Icon(Icons.rotate_right),
                          label: const Text('Rotate'),
                        ),
                        TextButton.icon(
                          onPressed: changed
                              ? () => setState(() {
                                  _turns = 0;
                                  _crop = const Rect.fromLTRB(0, 0, 1, 1);
                                })
                              : null,
                          icon: const Icon(Icons.restart_alt),
                          label: const Text('Reset'),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

enum _Drag { none, move, tl, tr, bl, br, left, right, top, bottom }

class _CropArea extends StatefulWidget {
  const _CropArea({
    required this.path,
    required this.aspect,
    required this.turns,
    required this.srcWide,
    required this.crop,
    required this.onChanged,
  });
  final String path;
  final double aspect; // width / height of the rotated image
  final int turns;
  final bool srcWide; // decode by width (else height) to cap the texture size
  final Rect crop;
  final ValueChanged<Rect> onChanged;

  @override
  State<_CropArea> createState() => _CropAreaState();
}

class _CropAreaState extends State<_CropArea> {
  static const _grab = 32.0;
  static const _minFrac = 0.08;
  _Drag _drag = _Drag.none;
  Rect _box = Rect.zero; // image rect inside the area, in local px
  Offset _start = Offset.zero; // where the current drag began
  Rect _startCrop = Rect.zero; // the crop when it began

  Rect get _crop => widget.crop;

  Rect _px(Rect f) => Rect.fromLTRB(
    _box.left + f.left * _box.width,
    _box.top + f.top * _box.height,
    _box.left + f.right * _box.width,
    _box.top + f.bottom * _box.height,
  );

  _Drag _hit(Offset p) {
    final r = _px(_crop);
    bool near(double a, double b) => (a - b).abs() <= _grab;
    final l = near(p.dx, r.left), rt = near(p.dx, r.right);
    final t = near(p.dy, r.top), b = near(p.dy, r.bottom);
    if (l && t) return _Drag.tl;
    if (rt && t) return _Drag.tr;
    if (l && b) return _Drag.bl;
    if (rt && b) return _Drag.br;
    final inY = p.dy > r.top - _grab && p.dy < r.bottom + _grab;
    final inX = p.dx > r.left - _grab && p.dx < r.right + _grab;
    if (l && inY) return _Drag.left;
    if (rt && inY) return _Drag.right;
    if (t && inX) return _Drag.top;
    if (b && inX) return _Drag.bottom;
    if (r.contains(p)) return _Drag.move;
    return _Drag.none;
  }

  // Applies the finger's total movement since the drag began to the crop it
  // began with, so there is no accumulated drift and no touch-slop jump.
  void _update(Offset delta) {
    if (_box.isEmpty) return;
    final dx = delta.dx / _box.width, dy = delta.dy / _box.height;
    final c = _startCrop;
    var l = c.left, t = c.top, r = c.right, b = c.bottom;
    switch (_drag) {
      case _Drag.none:
        return;
      case _Drag.move:
        final w = r - l, h = b - t;
        l = (l + dx).clamp(0.0, 1 - w);
        t = (t + dy).clamp(0.0, 1 - h);
        r = l + w;
        b = t + h;
      case _Drag.tl:
        l += dx;
        t += dy;
      case _Drag.tr:
        r += dx;
        t += dy;
      case _Drag.bl:
        l += dx;
        b += dy;
      case _Drag.br:
        r += dx;
        b += dy;
      case _Drag.left:
        l += dx;
      case _Drag.right:
        r += dx;
      case _Drag.top:
        t += dy;
      case _Drag.bottom:
        b += dy;
    }
    l = l.clamp(0.0, r - _minFrac);
    r = r.clamp(l + _minFrac, 1.0);
    t = t.clamp(0.0, b - _minFrac);
    b = b.clamp(t + _minFrac, 1.0);
    widget.onChanged(Rect.fromLTRB(l, t, r, b));
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        const pad = 24.0;
        final avail = Size(c.maxWidth - pad * 2, c.maxHeight - pad * 2);
        var w = avail.width, h = w / widget.aspect;
        if (h > avail.height) {
          h = avail.height;
          w = h * widget.aspect;
        }
        _box = Rect.fromLTWH((c.maxWidth - w) / 2, (c.maxHeight - h) / 2, w, h);
        final turns = widget.turns;
        // Raw pointer events: a GestureDetector pan waits out the touch slop
        // and then reports only the movement after it, which feels laggy.
        return Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: (e) {
            _drag = _hit(e.localPosition);
            _start = e.localPosition;
            _startCrop = _crop;
          },
          onPointerMove: (e) => _update(e.localPosition - _start),
          onPointerUp: (_) => _drag = _Drag.none,
          onPointerCancel: (_) => _drag = _Drag.none,
          child: Stack(
            children: [
              Positioned.fromRect(
                rect: _box,
                // Decoded at screen-ish size and cached as its own layer so a
                // drag only repaints the overlay, not a 3000px photo.
                child: RepaintBoundary(
                  child: RotatedBox(
                    quarterTurns: turns,
                    child: Image.file(
                      File(widget.path),
                      fit: BoxFit.fill,
                      cacheWidth: widget.srcWide ? 1600 : null,
                      cacheHeight: widget.srcWide ? null : 1600,
                      filterQuality: FilterQuality.low,
                    ),
                  ),
                ),
              ),
              Positioned.fill(
                child: CustomPaint(
                  painter: _CropPainter(_px(_crop), _box),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _CropPainter extends CustomPainter {
  _CropPainter(this.rect, this.bounds);
  final Rect rect;
  final Rect bounds;

  @override
  void paint(Canvas canvas, Size size) {
    final dim = Paint()..color = Colors.black.withValues(alpha: 0.6);
    canvas.drawPath(
      Path()
        ..addRect(bounds)
        ..addRect(rect)
        ..fillType = PathFillType.evenOdd,
      dim,
    );
    final line = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    canvas.drawRect(rect, line);
    final grid = Paint()
      ..color = Colors.white54
      ..strokeWidth = 0.5;
    for (var i = 1; i < 3; i++) {
      final x = rect.left + rect.width * i / 3;
      final y = rect.top + rect.height * i / 3;
      canvas.drawLine(Offset(x, rect.top), Offset(x, rect.bottom), grid);
      canvas.drawLine(Offset(rect.left, y), Offset(rect.right, y), grid);
    }
    final handle = Paint()..color = Colors.white;
    for (final p in [
      rect.topLeft,
      rect.topRight,
      rect.bottomLeft,
      rect.bottomRight,
    ]) {
      canvas.drawCircle(p, 8, handle);
    }
  }

  @override
  bool shouldRepaint(_CropPainter old) =>
      old.rect != rect || old.bounds != bounds;
}
