# Putting the download page live at ettuning.net/client-download

Everything is in this folder:

```
download-page/
  firebase.json                     hosting settings, incl. the ettuning.net -> /client-download redirect
  public/client-download/index.html the download page
  public/client-download/logo.jpg
```

The download button looks up the newest GitHub release of hoochmech/ettuningrustdesk each time the
page loads and links the `ETTuningRemote-<version>-x86_64.msi` installer.
New client versions need no page change. Until the first release is tagged, the button opens
the GitHub releases page.

## 1. Deploy with Firebase Hosting (free, part of your Google Cloud project)

On your own computer, with Node.js installed:

```
npm install -g firebase-tools
firebase login
cd download-page
firebase use --add                        # pick your existing Google Cloud project
firebase deploy --only hosting
```

Check it at `https://<your-project-id>.web.app/client-download/`.

## 2. Connect ettuning.net

1. Firebase console -> Hosting -> **Add custom domain** -> enter `ettuning.net`.
2. Firebase shows DNS records (a TXT record to verify, then A records). Add them at the
   company where ettuning.net's DNS is managed.
   - Replace any existing A/AAAA records for the bare `ettuning.net`, otherwise some visitors
     still reach the old host.
   - Leave MX records alone so email keeps working.
3. Optionally add `www.ettuning.net` too and choose "redirect to ettuning.net".
4. Firebase issues the HTTPS certificate itself; it can take up to a few hours after DNS updates.

## The redirect

`firebase.json` already sends `ettuning.net/` to `ettuning.net/client-download/`, so you don't need
to set that up anywhere else. It is a temporary (302) redirect, so you can later put a real home
page at the root by removing the `redirects` block and adding `public/index.html`.

To update the page: edit the files in `download-page/public/` and run `firebase deploy --only hosting` again.
