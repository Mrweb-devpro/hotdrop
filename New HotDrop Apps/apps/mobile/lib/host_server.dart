import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:mime/mime.dart';

typedef AssetLoader = Future<Uint8List> Function(String path);

class HostServer {
  HostServer(this.directory, this.loadAsset);
  final Directory directory;
  final AssetLoader loadAsset;
  HttpServer? _server;
  final List<Map<String, dynamic>> files = [];
  final List<Map<String, dynamic>> texts = [];
  final Map<String, Map<String, dynamic>> _peers = {};
  final Map<String, DateTime> _seen = {};
  final Random _random = Random.secure();
  int get port => _server?.port ?? 8080;
  bool get running => _server != null;
  String _id() => '${DateTime.now().microsecondsSinceEpoch}-${_random.nextInt(1 << 30)}';
  static const maxFileBytes = 1024 * 1024 * 1024;
  static const unknown = {'id': 'unknown', 'name': 'Unknown', 'color': '#FACC15'};

  Map<String, dynamic> peer(dynamic value) {
    if (value is! Map) return Map.of(unknown);
    return {
      'id': '${value['id'] ?? 'unknown'}'.substring(0, min(80, '${value['id'] ?? 'unknown'}'.length)),
      'name': '${value['name'] ?? 'Unknown'}'.substring(0, min(80, '${value['name'] ?? 'Unknown'}'.length)),
      'color': RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch('${value['color']}') ? value['color'] : '#FACC15',
    };
  }

  Future<void> start({int port = 8080}) async {
    if (running) return;
    await directory.create(recursive: true);
    _server = await HttpServer.bind(InternetAddress.anyIPv4, port);
    _server!.listen((request) { unawaited(_handle(request)); });
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    await server?.close(force: true);
  }

  Future<List<String>> addresses() async {
    final interfaces = await NetworkInterface.list(type: InternetAddressType.IPv4, includeLinkLocal: false);
    final result = <String>[];
    // Physical WiFi/hotspot interfaces precede VPN and cellular addresses.
    interfaces.sort((a, b) => _rank(a.name).compareTo(_rank(b.name)));
    for (final interface in interfaces) {
      for (final address in interface.addresses) {
        if (!address.isLoopback) result.add(address.address);
      }
    }
    return result;
  }

  int _rank(String name) => RegExp(r'wlan|wifi|ap\d|swlan', caseSensitive: false).hasMatch(name) ? 0 : 1;

  Future<void> _json(HttpRequest request, Object body, [int status = 200]) async {
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType.json;
    request.response.write(jsonEncode(body));
  }

  Future<String> _readText(Stream<List<int>> stream, int limit) async {
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in stream) {
      if (bytes.length + chunk.length > limit) throw const HttpException('Text/request is too large');
      bytes.add(chunk);
    }
    return utf8.decode(bytes.takeBytes());
  }

  Future<void> _upload(HttpRequest request) async {
    final boundary = request.headers.contentType?.parameters['boundary'];
    if (boundary == null) throw const FormatException('Multipart boundary required');
    final pending = <Map<String, dynamic>>[];
    final created = <File>[];
    var from = Map<String, dynamic>.of(unknown);
    try {
      await for (final part in MimeMultipartTransformer(boundary).bind(request)) {
        final disposition = HeaderValue.parse(part.headers['content-disposition'] ?? '');
        final field = disposition.parameters['name'];
        final filename = disposition.parameters['filename'];
        if (field == 'from') {
          from = peer(jsonDecode(await _readText(part, 4096)));
        } else if (field == 'files' && filename != null) {
          if (pending.length >= 20) throw const HttpException('Maximum 20 files per upload');
          final name = filename.split(RegExp(r'[/\\]')).last;
          final stored = '${_id()}-${name.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_')}';
          final file = File('${directory.path}/$stored');
          created.add(file);
          final sink = file.openWrite();
          var size = 0;
          try {
            await for (final chunk in part) {
              size += chunk.length;
              if (size > maxFileBytes) throw const HttpException('Maximum file size is 1 GB');
              sink.add(chunk);
              // Flush applies backpressure instead of buffering the whole file.
              await sink.flush();
            }
          } finally {
            await sink.close();
          }
          pending.add({'id': _id(), 'name': name, 'size': size,
            'mime': part.headers['content-type'] ?? 'application/octet-stream',
            'url': '/api/files/${Uri.encodeComponent(stored)}',
            'at': DateTime.now().millisecondsSinceEpoch});
        } else {
          await part.drain<void>();
        }
      }
      for (final item in pending) { item['from'] = from; }
      files.insertAll(0, pending);
      if (files.length > 200) files.removeRange(200, files.length);
      await _json(request, {'files': pending});
    } catch (_) {
      for (final file in created) { if (await file.exists()) await file.delete(); }
      rethrow;
    }
  }

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Cache-Control', 'no-store');
    try {
      final path = request.uri.path;
      if (request.method == 'GET' && path == '/api/info') {
        final ips = await addresses();
        final requestedHost = request.requestedUri.host;
        // Only advertise an address that belongs to this host.
        final advertisedIp = ips.contains(requestedHost)
            ? requestedHost
            : (ips.isEmpty ? '127.0.0.1' : ips.first);
        await _json(request, {'ip': advertisedIp,
          'addresses': ips, 'port': port, 'hostName': 'HotDrop Mobile Host', 'realtime': 'polling'});
      } else if (request.method == 'GET' && path == '/api/files') {
        await _json(request, {'files': files});
      } else if (request.method == 'GET' && path == '/api/texts') {
        await _json(request, {'texts': texts});
      } else if (request.method == 'POST' && path == '/api/peer') {
        final p = peer(jsonDecode(await _readText(request, 4096)));
        _peers[p['id']] = p;
        _seen[p['id']] = DateTime.now();
        _seen.removeWhere((key, time) => DateTime.now().difference(time).inSeconds > 10);
        _peers.removeWhere((key, _) => !_seen.containsKey(key));
        await _json(request, {'peers': _peers.values.toList()});
      } else if (request.method == 'POST' && path == '/api/upload') {
        await _upload(request);
      } else if (request.method == 'POST' && path == '/api/text') {
        final body = jsonDecode(await _readText(request, 32768));
        if (body is! Map || body['text'] is! String || (body['text'] as String).trim().isEmpty || body['from'] == null) {
          throw const FormatException('text and from required');
        }
        final text = body['text'] as String;
        final uri = Uri.tryParse(text.trim());
        final item = <String, dynamic>{'id': _id(), 'text': text.substring(0, min(text.length, 5000)),
          'type': uri != null && (uri.scheme == 'http' || uri.scheme == 'https') && uri.host.isNotEmpty ? 'link' : 'text',
          'from': peer(body['from']), 'at': DateTime.now().millisecondsSinceEpoch};
        texts.insert(0, item);
        if (texts.length > 200) texts.removeLast();
        await _json(request, {'item': item});
      } else if (request.method == 'GET' && path.startsWith('/api/files/')) {
        final filename = request.uri.pathSegments.last;
        if (!RegExp(r'^[a-zA-Z0-9._-]+$').hasMatch(filename) || filename == '.' || filename == '..') {
          throw const FormatException('Invalid filename');
        }
        final known = files.where((item) => item['url'] == '/api/files/${Uri.encodeComponent(filename)}');
        final file = File('${directory.path}/$filename');
        if (known.isEmpty || !await file.exists()) {
          await _json(request, {'error': 'File not found'}, 404);
        } else {
          response.headers.contentType = ContentType.binary;
          response.headers.set('Content-Disposition', "attachment; filename*=UTF-8''${Uri.encodeComponent(known.first['name'] as String)}");
          response.contentLength = await file.length();
          await response.addStream(file.openRead());
        }
      } else if (request.method == 'GET' && !path.startsWith('/api/') && !path.startsWith('/socket.io')) {
        if (request.uri.pathSegments.any((s) => s == '..' || s.contains('\\'))) throw const FormatException('Invalid path');
        final asset = path == '/' ? 'index.html' : path.substring(1);
        try {
          final bytes = await loadAsset('assets/web/$asset');
          response.headers.set('Content-Type', lookupMimeType(asset) ?? 'application/octet-stream');
          response.add(bytes);
        } catch (_) {
          await _json(request, {'error': 'Page not found'}, 404);
        }
      } else {
        await _json(request, {'error': 'Not found'}, 404);
      }
    } on FormatException catch (e) {
      await _json(request, {'error': e.message}, 400);
    } on HttpException catch (e) {
      await _json(request, {'error': e.message}, 413);
    } catch (_) {
      try { await _json(request, {'error': 'Request failed. Check storage and retry.'}, 500); } catch (_) { /* disconnected */ }
    } finally {
      try { await response.close(); } catch (_) { /* disconnected */ }
    }
  }
}
