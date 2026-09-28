# قالب‌های پاسخ برای فروم n8n (community.n8n.io/c/jobs)

نکته صادقانه قبل از استفاده: من نمی‌توانم برایت سابقه یا پروژه‌ی واقعی جعل کنم؛ در تحقیق فروم دیدم رقبا وقتی صادقانه می‌گویند "این بخش را تازه دارم، ولی این دمو را برای دقیقاً همین کاربرد ساختم" جواب بهتری می‌گیرند تا ادعای اغراق‌آمیز. پس این قالب‌ها را طوری نوشتم که به‌جای «۲ سال سابقه در n8n»، روی چیزی تکیه کند که واقعاً داری: دموی تست‌شده‌ی WhatsApp lead bot که همین امروز ساختیم، و پس‌زمینه‌ات در کدنویسی/اتوماسیون (Pine Script، پایتون، API).

## قبل از ارسال: دموی خودت را آنلاین کن
۱. یک GitHub Gist یا ریپو عمومی بساز و پوشه‌ی `wa-lead-bot` (که برایت فرستادم) را در آن بگذار.
۲. لینک را در پاسخ‌ها جایگزین `[LINK]` کن.
بدون لینک واقعی، پاسخ دادن بی‌اثر است — رقبا همه لینک گیت‌هاب/دمو گذاشته بودند.

---

## قالب A — برای پست‌های همکاری بلندمدت/ساب‌کانترکت (مثل تاپیک ۳۱۶۷۹۲)

```
Hi [NAME],

WhatsApp lead handling is exactly the shape of project I've been building toward. I don't have production WhatsApp Cloud API mileage yet, so I'd rather show you than claim it:

I built a WhatsApp lead-intake bot in n8n — inbound message → AI reply with a self-reported confidence score → automatic handoff to a human when the AI is unsure, the customer sounds upset, or two media-only messages arrive in a row. Duplicate webhook delivery, non-text messages, and malformed/truncated AI responses are all handled explicitly, not just on the happy path — 28 unit tests plus 10 integration tests run the actual workflow code against a mock server, all passing. Workflow + tests + README: [LINK]

Background: I come from Python/API integration work (trading-bot automation, exchange APIs), so webhooks, retries, and state handling aren't new — n8n and WhatsApp Cloud API specifically are what I'm applying that to now.

I'd be glad to start with a small paid test project so you can judge the work before anything bigger. Payment in USDT works for me — good to flag that upfront.

Timezone: Iran, UTC+3:30. Happy to share more of the demo or walk through the architecture.

Best,
Amin
```

---

## قالب B — برای پست‌های پروژه‌ی مشخص با بودجه‌ی اعلام‌شده

```
Hi,

For [describe their exact ask in one line, from their post], here's how I'd build it: [1-2 sentences on your approach — inbound trigger → processing/AI step → CRM or output → error handling]. I'm being direct that I haven't shipped this exact stack in production yet; what I can show is a closely related workflow I built and actually tested end-to-end (unit + integration tests against a mock server, not just a happy-path demo): [LINK]

Happy to scope this as a fixed price once I know [ask one real clarifying question about their spec]. Payment in USDT/crypto — wanted to mention that early rather than after we agree on scope.

Based in Iran (UTC+3:30), available to start right away.

Best,
Amin
```

---

## راهنمای سریع استفاده
- فقط به تاپیک‌هایی جواب بده که خودشان بودجه یا مدل پرداخت را گفته‌اند یا صراحتاً دنبال ساب‌کانترکتور می‌گردند («looking for», «hiring», «subcontractor», «white label», «ongoing collaboration»).
- هر پاسخ را با ۱-۲ جمله‌ی مخصوص همان تاپیک شخصی‌سازی کن (چیزی که دقیقاً خواسته‌اند) — پاسخ‌های کپی‌پیست محض در همان تاپیک‌ها دیده و نادیده گرفته می‌شوند.
- شرط پرداخت USDT را همان پیام اول بگو، نه بعد از توافق — دقیقاً طبق تحقیق قبلی.
- تاپیک ۳۱۶۷۹۲ («Looking for 1–2 n8n Builders for Long-Term Collaboration») دقیقاً با این دمو هم‌خوان است و هنوز امروز باز است — اولویت اول برای امتحان قالب A همین‌جاست.
