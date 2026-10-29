import 'package:url_launcher/url_launcher.dart';

import '../models/model.dart';
import '../models/platform_model.dart';

/// Opens the ET Tuning dashboard's job form for the latest session on [peerId].
/// The dashboard is served from the client's API server.
Future<void> openJobForm(String peerId) async {
  final api = await bind.mainGetApiServer();
  if (api.isEmpty) return;
  final id = peerId.split('@').first;
  await launchUrl(Uri.parse('$api/#device=${Uri.encodeComponent(id)}'),
      mode: LaunchMode.externalApplication);
}

/// Opens the job form when a logged-in remote desktop session ends, so every
/// session gets its details filled in (or reviewed, if they were saved during it).
void openJobFormOnSessionEnd(FFI ffi, String peerId) {
  if (ffi.connType != ConnType.defaultConn || !ffi.ffiModel.pi.isSet.isTrue) {
    return;
  }
  openJobForm(peerId);
}
