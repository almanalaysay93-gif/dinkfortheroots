"""Browser regression checks with local assets and a mocked registration API.

Requires: pip install playwright; playwright install chromium
Run: python -m unittest discover -s tests -p 'test_capacity_browser.py' -v
No production registrations, payments, emails, or Sheet writes are performed.
"""
import base64
import json
import mimetypes
import os
from pathlib import Path
import shutil
import unittest
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

SITE = Path(__file__).resolve().parents[1] / 'site'
ACTIVE = ['novice-mens', 'novice-womens', 'novice-mixed', 'rookie-mixed']
ALL = ACTIVE + ['rookie-mens', 'rookie-womens']
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


class CapacityBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or shutil.which('chromium')
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.state = {'open': True, 'slots': {key: {'taken': 0, 'cap': 40} for key in ALL}}
        self.fail = False
        self.post_result = 'success'
        self.posts = []
        self.errors = []
        self.context = self.browser.new_context(reduced_motion='reduce')
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        if url.hostname == 'script.google.com':
            headers = {'Access-Control-Allow-Origin': '*'}
            if request.method == 'POST':
                payload = json.loads(request.post_data)
                self.posts.append(payload)
                self.state['slots'][payload['player']['category']]['taken'] = 40
                body = {'ok': True, 'ref': 'DFR-TEST23'} if self.post_result == 'success' else {'ok': False, 'error': self.post_result}
                route.fulfill(json=body, headers=headers)
            else:
                route.fulfill(status=503 if self.fail else 200, json={'ok': True, **self.state}, headers=headers)
        elif url.hostname == 'capacity.test':
            target = SITE / (url.path.lstrip('/') or 'index.html')
            if target.is_file() and SITE in target.resolve().parents:
                route.fulfill(path=str(target), content_type=mimetypes.guess_type(str(target))[0] or 'application/octet-stream')
            else:
                route.fulfill(status=404, body='Not found')
        else:
            route.abort()

    def open_page(self):
        self.page.goto('http://capacity.test/', wait_until='load')
        self.page.wait_for_function("document.querySelector('[data-rslots]').textContent !== '' || !document.querySelector('#slotsNote').hidden")

    def refresh(self):
        return self.page.evaluate("async () => (await import('/js/form.js')).loadSlots()")

    def choose(self, category):
        self.page.locator('label.rcard').filter(has=self.page.locator('input[value="' + category + '"]')).locator('.rcard__title').click()
        self.refresh()

    def fill_form(self, category='rookie-mixed'):
        for key, value in {'fullName': 'TEST ONLY Player', 'email': 'test@example.com', 'phone': '09000000000', 'partnerName': 'TEST ONLY Partner', 'barangay': 'TEST ONLY', 'paymentRef': 'TEST-NO-PAYMENT'}.items():
            self.page.locator('#' + key).fill(value)
        self.page.locator('#municipality').select_option('Digos City')
        self.choose(category)
        self.page.locator('label.size').filter(has=self.page.locator('input[value="M"]')).locator('span').click()
        for key in ['receipt', 'validId']:
            self.page.locator('#' + key).set_input_files({'name': 'TEST-ONLY.png', 'mimeType': 'image/png', 'buffer': PNG})
        self.page.locator('#consent').check()

    def test_all_active_full_closes_even_when_removed_categories_have_space(self):
        for key in ACTIVE:
            self.state['slots'][key]['taken'] = 40
        self.open_page()
        self.assertTrue(self.page.locator('#closedNote').is_visible())
        self.assertIn('40 players', self.page.locator('#closedNote').inner_text())
        self.assertTrue(self.page.locator('#submitBtn').is_disabled())
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertEqual(self.posts, [])
        # A rejected entry frees a slot; the form can reopen without a page reload.
        self.state['slots']['rookie-mixed']['taken'] = 39
        self.refresh()
        self.assertTrue(self.page.locator('#closedNote').is_hidden())
        self.choose('rookie-mixed')
        self.assertTrue(self.page.locator('#payQr').is_visible())

    def test_qr_only_for_open_selection_and_hides_when_that_category_fills(self):
        self.open_page()
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.choose('novice-mens')
        self.assertTrue(self.page.locator('#payQr').is_visible())
        self.state['slots']['novice-mens']['taken'] = 40
        self.refresh()
        self.assertTrue(self.page.locator('input[value="novice-mens"]').is_disabled())
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertTrue(self.page.locator('#closedNote').is_hidden())
        self.choose('rookie-mixed')
        self.assertTrue(self.page.locator('#payQr').is_visible())

    def test_deadline_closes_and_hides_payment(self):
        self.state['open'] = False
        self.open_page()
        self.assertTrue(self.page.locator('#closedNote').is_visible())
        self.assertTrue(self.page.locator('#submitBtn').is_disabled())
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertTrue(self.page.locator('#pay-hint').is_hidden())

    def test_wrong_device_clock_cannot_override_live_server(self):
        self.page.add_init_script("Date.now = () => Date.parse('2027-01-01T00:00:00Z')")
        self.open_page()
        self.choose('rookie-mixed')
        self.assertTrue(self.page.locator('#closedNote').is_hidden())
        self.assertTrue(self.page.locator('#payQr').is_visible())

    def test_availability_failure_hides_qr_and_pauses_submission_then_recovers(self):
        self.open_page()
        self.choose('rookie-mixed')
        self.fail = True
        self.assertFalse(self.refresh())
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertTrue(self.page.locator('#submitBtn').is_disabled())
        self.fail = False
        self.assertTrue(self.refresh())
        self.assertTrue(self.page.locator('#payQr').is_visible())
        self.assertTrue(self.page.locator('#submitBtn').is_enabled())

    def test_missing_counts_cannot_expose_payment(self):
        del self.state['slots']['rookie-mixed']
        self.open_page()
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertTrue(self.page.locator('#submitBtn').is_disabled())

    def test_pre_submit_refresh_stops_a_newly_full_category_without_post(self):
        self.open_page()
        self.fill_form()
        self.state['slots']['rookie-mixed']['taken'] = 40
        self.page.locator('#submitBtn').click()
        self.page.wait_for_function("document.querySelector('#formStatus').textContent.includes('This category is full')")
        self.assertEqual(self.posts, [])
        self.assertTrue(self.page.locator('#payQr').is_hidden())

    def test_server_full_race_hides_qr_and_keeps_other_categories_open(self):
        self.open_page()
        self.fill_form()
        self.post_result = 'FULL'
        self.page.locator('#submitBtn').click()
        self.page.wait_for_function("document.querySelector('#submitBtn').getAttribute('aria-busy') === 'false' && document.querySelector('#formStatus').textContent.includes('This category is full')")
        self.assertEqual(len(self.posts), 1)
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertTrue(self.page.locator('input[value="rookie-mixed"]').is_disabled())
        self.assertTrue(self.page.locator('#closedNote').is_hidden())

    def test_final_player_success_preserved_while_form_closes(self):
        for key in ACTIVE:
            self.state['slots'][key]['taken'] = 40
        self.state['slots']['rookie-mixed']['taken'] = 39
        self.open_page()
        self.fill_form()
        self.page.locator('#submitBtn').click()
        self.page.wait_for_function("!document.querySelector('#closedNote').hidden")
        self.assertIn('DFR-TEST23', self.page.locator('#formStatus').inner_text())
        self.assertTrue(self.page.locator('#submitBtn').is_disabled())
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertEqual(len(self.posts), 1)

    def test_automatic_refresh_closes_an_already_open_page(self):
        self.page.clock.install()
        self.open_page()
        self.choose('rookie-mixed')
        for key in ACTIVE:
            self.state['slots'][key]['taken'] = 40
        self.page.clock.fast_forward(31000)
        self.page.wait_for_function("!document.querySelector('#closedNote').hidden")
        self.assertTrue(self.page.locator('#payQr').is_hidden())
        self.assertTrue(self.page.locator('#submitBtn').is_disabled())


if __name__ == '__main__':
    unittest.main()
