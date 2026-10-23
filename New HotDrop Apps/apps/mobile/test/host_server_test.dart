import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:hotdrop_mobile/host_server.dart';

class _TestHostServer extends HostServer {
  _TestHostServer(super.directory, super.loadAsset, {super.maxUploadBytes});
  bool failAddresses = false;

  @override
  Future<List<String>> addresses() async {
    if (failAddresses) throw const SocketException('Network is changing');
    return ['192.168.43.1', '192.168.1.2'];
  }
}

void main() {
  late Directory temp;
  late _TestHostServer host;
  late HttpClient client;
  late String base;
  setUp(() async {
    temp = await Directory.systemTemp.createTemp('hotdrop-test-');
    host = _TestHostServer(temp, (path) async {
      if (path == 'assets/web/index.html') return Uint8List.fromList(utf8.encode('<h1>HotDrop</h1>'));
      if (path == 'assets/web/assets/main.js') return Uint8List.fromList(utf8.encode('console.log("HotDrop")'));
      throw StateError('Asset not found');
    }, maxUploadBytes: 1024);
    await host.start(port: 0);
    base = 'http://127.0.0.1:${host.port}';
    client = HttpClient();
  });
  tearDown(() async { client.close(force: true); await host.stop(); await temp.delete(recursive: true); });

  Future<HttpClientResponse> upload(List<String> filenames, {int bytes = 1, String from = '{"id":"test"}'}) async {
    final request = await client.postUrl(Uri.parse('$base/api/upload'));
    request.headers.set('Content-Type', 'multipart/form-data; boundary=hotdrop-limits');
    for (final name in filenames) {
      request.add(utf8.encode('--hotdrop-limits\r\nContent-Disposition: form-data; name="files"; filename="$name"\r\n\r\n'));
      request.add(List.filled(bytes, 42));
      request.add(utf8.encode('\r\n'));
    }
    request.add(utf8.encode('--hotdrop-limits\r\nContent-Disposition: form-data; name="from"\r\n\r\n$from\r\n--hotdrop-limits--\r\n'));
    return request.close();
  }

  test('concurrent startup binds only one server', () async {
    await host.stop();
    await Future.wait([host.start(port: 0), host.start(port: 0)]);
    await host.checkReady();
    expect(host.running, true);
  });

  test('occupied port falls back to an available port', () async {
    await host.stop();
    final occupied = await ServerSocket.bind(InternetAddress.anyIPv4, 0);
    try {
      await host.start(port: occupied.port, allowPortFallback: true);
      expect(host.port, isNot(occupied.port));
      await host.checkReady();
    } finally { await occupied.close(); }
  });

  test('stop during startup closes the eventual listener', () async {
    await host.stop();
    final starting = host.start(port: 0);
    final stopping = host.stop();
    await Future.wait([starting, stopping]);
    expect(host.running, false);
  });

  test('missing web bundle fails startup before advertising success', () async {
    final broken = HostServer(temp, (_) async => throw StateError('Missing web bundle'));
    await expectLater(broken.start(port: 0), throwsA(isA<StateError>()));
    expect(broken.running, false);
    await broken.stop();
  });

  test('temporary interface discovery failure does not stop hosting', () async {
    host.failAddresses = true;
    final response = await (await client.getUrl(Uri.parse('$base/api/info'))).close();
    expect(response.statusCode, 200);
    final info = jsonDecode(await utf8.decoder.bind(response).join());
    expect(info['ip'], '127.0.0.1');
    expect(info['addresses'], isEmpty);
    await host.checkReady();
  });

  test('bundled script has a browser-compatible MIME type and missing assets return 404', () async {
    final script = await (await client.getUrl(Uri.parse('$base/assets/main.js'))).close();
    expect(script.statusCode, 200);
    expect(script.headers.contentType?.mimeType, contains('javascript'));
    await script.drain<void>();
    final missing = await (await client.getUrl(Uri.parse('$base/missing.js'))).close();
    expect(missing.statusCode, 404);
    await missing.drain<void>();
  });

  test('long display filenames do not exceed filesystem path limits', () async {
    final name = '${List.filled(240, 'A').join()}.bin';
    final response = await upload([name]);
    expect(response.statusCode, 200);
    final body = jsonDecode(await utf8.decoder.bind(response).join());
    expect(body['files'][0]['name'], name);
    expect((await temp.list().toList()).single.path.length, lessThan(temp.path.length + 80));
  });

  test('oversized uploads remove partial files and leave the host responsive', () async {
    final response = await upload(['too-big.bin'], bytes: 1025);
    expect(response.statusCode, 413);
    await response.drain<void>();
    expect(host.files, isEmpty);
    expect(await temp.list().toList(), isEmpty);
    await host.checkReady();
  });

  test('too many files roll back the entire upload', () async {
    final response = await upload(List.generate(21, (i) => '$i.bin'));
    expect(response.statusCode, 413);
    await response.drain<void>();
    expect(host.files, isEmpty);
    expect(await temp.list().toList(), isEmpty);
  });

  test('invalid sender after a file rolls back the partial upload', () async {
    final response = await upload(['partial.bin'], from: '{broken');
    expect(response.statusCode, 400);
    await response.drain<void>();
    expect(host.files, isEmpty);
    expect(await temp.list().toList(), isEmpty);
  });

  test('empty upload is rejected', () async {
    final response = await upload([]);
    expect(response.statusCode, 400);
    await response.drain<void>();
  });

  test('incomplete multipart body cannot leave a published or partial file', () async {
    final request = await client.postUrl(Uri.parse('$base/api/upload'));
    request.headers.set('Content-Type', 'multipart/form-data; boundary=unfinished');
    request.add(utf8.encode('--unfinished\r\nContent-Disposition: form-data; name="files"; filename="partial.bin"\r\n\r\npartial'));
    final response = await request.close();
    expect(response.statusCode, greaterThanOrEqualTo(400));
    await response.drain<void>();
    expect(host.files, isEmpty);
    expect(await temp.list().toList(), isEmpty);
    await host.checkReady();
  });

  test('text limit does not split an emoji into invalid Unicode', () async {
    final request = await client.postUrl(Uri.parse('$base/api/text'));
    final expected = '${List.filled(4999, 'x').join()}\u{1f642}';
    request.write(jsonEncode({'text': '${expected}extra', 'from': {'id': 'test'}}));
    final response = await request.close();
    expect(response.statusCode, 200);
    final body = jsonDecode(await utf8.decoder.bind(response).join());
    expect(body['item']['text'], expected);
  });

  test('info advertises a known host address and rejects arbitrary host headers', () async {
    for (final requested in ['192.168.1.2', 'untrusted.example', '127.0.0.1']) {
      final request = await client.getUrl(Uri.parse('$base/api/info'));
      request.headers.set(HttpHeaders.hostHeader, '$requested:${host.port}');
      final response = await request.close();
      expect(response.statusCode, 200);
      final body = jsonDecode(await utf8.decoder.bind(response).join());
      expect(body['ip'], requested == '192.168.1.2' ? requested : '192.168.43.1');
      expect(body['port'], host.port);
      expect(body['realtime'], 'polling');
    }
  });

  test('starts, serves bundled UI, and can restart', () async {
    final response = await (await client.getUrl(Uri.parse('$base/'))).close();
    expect(await utf8.decoder.bind(response).join(), contains('HotDrop'));
    await host.stop();
    await host.start(port: 0);
    expect(host.running, true);
  });

  test('text validation and full text API', () async {
    final request = await client.postUrl(Uri.parse('$base/api/text'));
    request.write(jsonEncode({'text': List.filled(600, 'x').join(), 'from': {'id': 'guest', 'name': 'Guest', 'color': 'bad'}}));
    final response = await request.close();
    final body = jsonDecode(await utf8.decoder.bind(response).join());
    expect(body['item']['text'].length, 600);
    expect(body['item']['from']['color'], '#FACC15');
    final invalid = await client.postUrl(Uri.parse('$base/api/text'));
    invalid.write('{}');
    final rejected = await invalid.close();
    expect(rejected.statusCode, 400);
    await rejected.drain<void>();
  });

  test('multipart preserves binary bytes and sender after files', () async {
    final request = await client.postUrl(Uri.parse('$base/api/upload'));
    request.headers.set('Content-Type', 'multipart/form-data; boundary=hotdrop-test');
    final bytes = List.generate(256, (i) => i);
    request.add(utf8.encode('--hotdrop-test\r\nContent-Disposition: form-data; name="files"; filename="photo.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    request.add(bytes);
    request.add(utf8.encode('\r\n--hotdrop-test\r\nContent-Disposition: form-data; name="from"\r\n\r\n{"id":"test","name":"David","color":"#FACC15"}\r\n--hotdrop-test--\r\n'));
    final response = await request.close();
    expect(response.statusCode, 200);
    final body = jsonDecode(await utf8.decoder.bind(response).join());
    final file = body['files'][0];
    expect(file['from']['name'], 'David');
    final download = await (await client.getUrl(Uri.parse('$base${file['url']}'))).close();
    final downloaded = await download.fold<List<int>>([], (all, chunk) => all..addAll(chunk));
    expect(downloaded, bytes);
  });

  test('unknown download and malformed JSON fail safely', () async {
    final response = await (await client.getUrl(Uri.parse('$base/api/files/missing.bin'))).close();
    expect(response.statusCode, 404);
    await response.drain<void>();
    final request = await client.postUrl(Uri.parse('$base/api/text'));
    request.write('{broken');
    final rejected = await request.close();
    expect(rejected.statusCode, 400);
    await rejected.drain<void>();
  });
}
