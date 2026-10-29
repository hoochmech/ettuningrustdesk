import 'package:url_launcher/url_launcher.dart';

import '../models/platform_model.dart';

/// Opens the ET Tuning dashboard's job form for the session in progress on
/// [peerId]. The dashboard is served from the client's API server.
Future<void> openJobForm(String peerId) async {
  final api = await bind.mainGetApiServer();
  if (api.isEmpty) return;
  final id = peerId.split('@').first;
  await launchUrl(Uri.parse('$api/#device=${Uri.encodeComponent(id)}'),
      mode: LaunchMode.externalApplication);
}
