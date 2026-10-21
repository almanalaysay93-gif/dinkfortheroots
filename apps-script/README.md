# Apps Script setup

Follow these steps once.
Sign in as `paddlebase@gmail.com` for every step.
Apps Script sends the confirmation emails from the account that deploys the web app.

1. Create a new Google Sheet.
2. Open Extensions > Apps Script.
3. Paste the contents of `Code.gs` into the editor file `Code.gs`.
4. Open Project Settings and turn on "Show appsscript.json manifest file".
5. Paste the contents of `appsscript.json` into the manifest file.
6. Select `setup` in the function list and click Run.
7. Approve the permissions when Google asks.
8. Open View > Logs and copy the value after `ADMIN_KEY:`.
9. Keep the admin key secret. Do not paste it into the site or into Git.
10. Open Project Settings > Script properties.
11. Set `POSTER_URL` to the public address of `poster.jpg`.
12. Leave `POSTER_URL` empty if the poster is not ready. Registration still works.
13. Click Deploy > New deployment.
14. Choose type Web app.
15. Set Execute as to Me.
16. Set Who has access to Anyone.
17. Click Deploy and copy the Web app URL. It ends in `/exec`.
18. Open `site/js/config.js`.
19. Paste the URL into `ENDPOINT`.

## Run the tests

Run this command from the project root:

    node --test tests/code.test.mjs
