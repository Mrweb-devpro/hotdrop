import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'host_server.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const HotDropApp());
}

class HotDropApp extends StatelessWidget {
  const HotDropApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'HotDrop', debugShowCheckedModeBanner: false,
    theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFFFACC15),
      scaffoldBackgroundColor: const Color(0xFFFFFBEB)),
    home: const HostScreen(),
  );
}

class HostScreen extends StatefulWidget {
  const HostScreen({super.key, this.createHost, this.keepAwake});
  final Future<HostServer> Function()? createHost;
  final Future<void> Function(bool enabled)? keepAwake;
  @override
  State<HostScreen> createState() => _HostScreenState();
}

class _HostScreenState extends State<HostScreen> with WidgetsBindingObserver {
  HostServer? host;
  Timer? refresh;
  Timer? copiedTimer;
  bool starting = false;
  bool checking = false;
  bool copied = false;
  List<String> ips = [];
  String? selected;
  String status = 'Starting sharing…';
  String? failure;
  String? url;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_start());
    refresh = Timer.periodic(const Duration(seconds: 3), (_) { unawaited(_refresh()); });
    // Keep the host visible and awake; background execution is not promised.
    unawaited(_keepAwake(true));
  }

  Future<void> _keepAwake(bool enabled) async {
    try {
      if (widget.keepAwake != null) { await widget.keepAwake!(enabled); }
      else { await WakelockPlus.toggle(enable: enabled); }
    } catch (_) { /* screen wake lock failure must not prevent hosting */ }
  }

  Future<void> _refresh() async {
    if (!mounted || starting || checking) return;
    if (host?.running != true) { await _start(); return; }
    checking = true;
    try {
      await host!.checkReady();
      await _addresses();
    } catch (_) {
      await host?.stop();
      await _start();
    } finally { checking = false; }
  }

  Future<void> _addresses() async {
    try {
      final addresses = (await host!.addresses()).toSet().toList();
      if (!mounted || host?.running != true) return;
      setState(() {
        ips = addresses;
        if (!ips.contains(selected)) selected = ips.isEmpty ? null : ips.first;
        url = selected == null ? null : 'http://$selected:${host!.port}';
      });
    } catch (_) {
      if (mounted) setState(() { ips = []; selected = null; url = null; });
    }
  }

  Future<HostServer> _createHost() async {
    if (widget.createHost != null) return widget.createHost!();
    final temp = await getTemporaryDirectory();
    return HostServer(Directory('${temp.path}/hotdrop-uploads'), (path) async {
      final data = await rootBundle.load(path);
      return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    });
  }

  Future<void> _start() async {
    if (!mounted || starting || host?.running == true) return;
    starting = true;
    try {
      final candidate = host ?? await _createHost();
      if (!mounted) { await candidate.stop(); return; }
      host = candidate;
      await host!.start(allowPortFallback: true);
      if (!mounted) { await host!.stop(); return; }
      await host!.checkReady();
      if (!mounted) return;
      setState(() { status = 'Sharing is ON · Auto-started'; failure = null; });
      await _addresses();
    } catch (e) {
      await host?.stop();
      if (mounted) setState(() { status = 'Could not start sharing'; failure = '$e'; url = null; });
    } finally { starting = false; }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_keepAwake(true));
      unawaited(_refresh());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    refresh?.cancel();
    copiedTimer?.cancel();
    unawaited(host?.stop() ?? Future<void>.value());
    unawaited(_keepAwake(false));
    super.dispose();
  }

  Widget card(List<Widget> children) => Container(
    width: double.infinity, padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20),
      border: Border.all(color: const Color(0xFFFDE68A))),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
  );

  Future<void> _open() async {
    try {
      final opened = await launchUrl(Uri.parse('http://127.0.0.1:${host!.port}'), mode: LaunchMode.externalApplication);
      if (!opened) throw const HttpException('No browser available');
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open browser: $e')));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(body: SafeArea(child: ListView(
    padding: const EdgeInsets.all(16), children: [
      const SizedBox(height: 16),
      Center(child: Container(padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: const Color(0xFFFACC15), borderRadius: BorderRadius.circular(18)),
        child: const Text('HD', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w900)))),
      const SizedBox(height: 10),
      const Text('HotDrop', textAlign: TextAlign.center, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w900)),
      const Text('Hotspot & LAN file + link sharing', textAlign: TextAlign.center),
      const SizedBox(height: 24),
      card([
        Text(status, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
        if (failure != null) ...[
          const SizedBox(height: 12), Text(failure!, style: const TextStyle(color: Colors.red)),
          const Text('Retrying automatically. Check that storage is available and reopen HotDrop if needed.'),
        ],
        if (host?.running == true && url == null) const Padding(padding: EdgeInsets.only(top: 16),
          child: Text('Server ready. Connect to WiFi or turn on your hotspot to get a sharing address.')),
        if (url != null && failure == null) ...[
          const SizedBox(height: 16),
          Center(child: QrImageView(data: url!, size: 200, backgroundColor: Colors.white)),
          Center(child: SelectableText(url!, style: const TextStyle(fontWeight: FontWeight.bold))),
          if (ips.length > 1) DropdownButton<String>(value: selected, isExpanded: true,
            items: ips.map((ip) => DropdownMenuItem(value: ip, child: Text(ip))).toList(),
            onChanged: (ip) { if (ip != null) setState(() { selected = ip; url = 'http://$ip:${host!.port}'; }); }),
          const SizedBox(height: 12),
          Wrap(spacing: 8, children: [
            FilledButton(onPressed: () async {
              try {
                await Clipboard.setData(ClipboardData(text: url!));
                if (!mounted) return;
                setState(() => copied = true);
                copiedTimer?.cancel();
                copiedTimer = Timer(const Duration(seconds: 2), () { if (mounted) setState(() => copied = false); });
              } catch (_) {
                if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copy failed. Long press the address to copy it.')));
              }
            }, child: Text(copied ? '✓ Copied' : 'Copy link')),
            OutlinedButton(onPressed: _open, child: const Text('Open sharing page')),
          ]),
        ],
      ]),
      const SizedBox(height: 16),
      card(const [
        Text('How it works', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
        SizedBox(height: 12),
        Text('1. Sharing starts automatically.\n2. Your friend joins your hotspot or the same WiFi.\n3. They scan the QR or open the address in their browser.\n4. Drop files or paste text on the sharing page.'),
        SizedBox(height: 12),
        Text('Keep HotDrop open while sharing. Open sharing page to send files from this phone. Android may suspend hosting while another app is in front. Return here if sharing pauses.'),
      ]),
      const SizedBox(height: 20),
      const Text('HotDrop · Danetech\nOffline · LAN only · No account', textAlign: TextAlign.center),
    ],
  )));
}
