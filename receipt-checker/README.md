# Receipt checker

This tool checks the payment receipts of the Dink for the Roots tournament.
It reads pending receipts from the Apps Script web app.
It reads the text of each receipt.
It writes a verdict back to the Google Sheet.

## 1. Check the installation

Open a Command Prompt in this folder.
Run this command.

```
python -c "import cv2, PIL, numpy, rapidocr_onnxruntime; print('ok')"
```

The command must print `ok`.
If it prints an error, install the missing package with pip.

## 2. Fill the settings file

Copy `.env.example` to `.env`.
Open `.env` in Notepad.
Set `ENDPOINT` to the web app address. It ends with `/exec`.
Set `ADMIN_KEY` to the admin key. It must match the `ADMIN_KEY` script property in Apps Script.
Keep `EXPECTED_AMOUNT` at `1000` unless the fee changes.
Set `EXPECTED_RECIPIENT` to part of the organizer account name or number. Leave it empty to skip this check.

Do not share the `.env` file.
Do not send the `ADMIN_KEY` to anyone.

## 3. Run the checker

Double-click `run-checker.bat`.
The window lists each receipt and its verdict.
The window waits at the end. Press any key to close it.

To test without writing results, run this command.

```
python check_receipts.py run --dry-run
```

To check one image on this PC, run this command.
The command does not use the network.

```
python check_receipts.py check "C:\path\to\receipt.jpg"
```

## 4. Read the verdicts

The checker writes one verdict for each receipt.

- `Verified`: No warning was found. All key fields were read.
- `Needs review`: A field was not read, or a weak warning was found. A person must check the receipt.
- `Suspect`: A strong warning was found. Examples are a wrong amount, a duplicate reference number, a duplicate image, an editor name in the metadata, or a date outside the event window. A person must check the receipt before approval.

The tamper score runs from 0 to 100.
A higher score means more warnings.
The Flags column lists each warning in plain words.

## 5. Limits

- The text reading (OCR) is a heuristic. It can read a number wrong.
- The tamper checks are heuristics. They can miss a good forgery. They can also flag a real receipt.
- A `Verified` result is not proof of payment.
- A person must check every `Needs review` and `Suspect` receipt.
- Check the amount and reference number against the GCash, Maya, or bank record when a result is unclear.
- The thresholds in `receipt_analysis.py` are starting values. They need calibration on real receipts.
- The checker reads at most 10 pending items at a time.
- If all 10 items fail to write, the checker stops. Fix the cause, then run it again.

## 6. Run every 10 minutes

Use Windows Task Scheduler to run the checker every 10 minutes.

1. Open Task Scheduler. Choose Create Task.
2. On the General tab, enter a name such as Dink receipt checker.
3. On the Triggers tab, choose New. Set the start time. Set the repeat to every 10 minutes for an indefinite duration.
4. On the Actions tab, choose New. Set Program to `python`. Set Start in to this folder.
5. Set Arguments to `check_receipts.py run`.
6. Save the task. Run it once by hand to confirm the result.

Check the console output or the Sheet after the first scheduled run.
