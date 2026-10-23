import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hotdrop_mobile/host_server.dart';
import 'package:hotdrop_mobile/main.dart';

class _FakeHost extends HostServer {
  _FakeHost() : super(Directory.systemTemp, (_) async => Uint8List(0));
  bool up = false;
  bool failNextStart = false;
  int starts = 0;
  int stops = 0;
  List<String> network = ['192.168.43.1'];
  @override
  bool get running => up;
  @override
  Future<void> start({int port = 8080, bool allowPortFallback = false}) async {
    starts++;
    if (failNextStart) {
      failNextStart = false;
      throw const SocketException('Startup failed');
    }
    up = true;
  }
  @override
  Future<void> stop() async { stops++; up = false; }
  @override
  Future<void> checkReady() async {
    if (!up) throw const HttpException('Server stopped');
  }
  @override
  Future<List<String>> addresses() async => network;
}

void main() {
  testWidgets('auto-starts and copies the complete link with temporary feedback', (tester) async {
    final host = _FakeHost();
    String? clipboard;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') clipboard = (call.arguments as Map)['text'] as String;
      return null;
    });
    await tester.pumpWidget(MaterialApp(home: HostScreen(createHost: () async => host, keepAwake: (_) async {})));
    await tester.pumpAndSettle();
    expect(host.starts, 1);
    expect(find.textContaining('Sharing is ON'), findsOneWidget);
    await tester.ensureVisible(find.text('Copy link'));
    await tester.tap(find.text('Copy link'));
    await tester.pump();
    expect(clipboard, 'http://192.168.43.1:8080');
    expect(find.textContaining('Copied'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('Copy link'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
    expect(host.running, false);
  });

  testWidgets('startup failure displays an error and automatically recovers', (tester) async {
    final host = _FakeHost()..failNextStart = true;
    await tester.pumpWidget(MaterialApp(home: HostScreen(createHost: () async => host, keepAwake: (_) async {})));
    await tester.pumpAndSettle();
    expect(find.text('Could not start sharing'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(host.starts, 2);
    expect(find.textContaining('Sharing is ON'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('network loss clears the old link and duplicate addresses are safe', (tester) async {
    final host = _FakeHost()..network = ['192.168.43.1', '192.168.43.1'];
    await tester.pumpWidget(MaterialApp(home: HostScreen(createHost: () async => host, keepAwake: (_) async {})));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    host.network = [];
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('Copy link'), findsNothing);
    expect(find.textContaining('Connect to WiFi'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('closing the screen during initialization cannot leave a server running', (tester) async {
    final created = Completer<HostServer>();
    final host = _FakeHost();
    await tester.pumpWidget(MaterialApp(home: HostScreen(createHost: () => created.future, keepAwake: (_) async {})));
    await tester.pumpWidget(const SizedBox.shrink());
    created.complete(host);
    await tester.pump();
    expect(host.starts, 0);
    expect(host.stops, 1);
    expect(tester.takeException(), isNull);
  });
}
