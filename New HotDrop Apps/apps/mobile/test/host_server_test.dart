import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:hotdrop_mobile/host_server.dart';

class _TestHostServer extends HostServer {
  _TestHostServer(super.directory, super.loadAsset);

  @override
  Future<List<String>> addresses() async => ['192.168.43.1', '192.168.1.2'];
}

void main() {
  late Directory temp;
  late HostServer host;
  late HttpClient client;
  late String base;
  setUp(() async {
    temp = await Directory.systemTemp.createTemp('hotdrop-test-');
    host = _TestHostServer(temp, (_) async => Uint8List.fromList(utf8.encode('<h1>HotDrop</h1>')));
    await host.start(port: 0);
    base = 'http://127.0.0.1:${host.port}';
    client = HttpClient();
  });
  tearDown(() async { client.close(force: true); await host.stop(); await temp.delete(recursive: true); });

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
