# Worked example: a complete mixed-methods study

**Trailhead Math evaluation — Ferncrest School District, 2024–25**

This walkthrough rebuilds the worked example from the raw files, start to finish.
You can also just open the finished project and take it apart — but building it
yourself is the fastest way to learn how the pieces of Mixed Measures fit
together.

The study is **explanatory sequential**: first the numbers show *which* schools
improved, then the interviews and focus groups explain *why*, and finally you
bring the two strands together on the canvas. Plan on an hour or two at an
unhurried pace.

Everything in the data is synthetic and fictional. A few realistic rough edges
are left in on purpose; the steps below point them out as you reach them.

---

## Before you start

Download and unzip the raw files. You should have four datasets (CSV), eight
principal interviews, four teacher focus groups, two program documents, and this
guide. Open Mixed Measures and you're ready.

---

## Part 1 — The quantitative strand: which schools improved?

**1. Create the project.**
New project → name it *Trailhead Math Evaluation — Ferncrest School District,
2024–25*. A one-line description helps later: "Explanatory sequential evaluation
of a new math curriculum across eight elementary schools."

**2. Import the student assessments.**
Datasets → Import → `student_assessments.csv`. Let auto-detect type the columns:
the IDs, `School`, `Grade`, and `Gender` come in as categorical; `Pre_Score`,
`Post_Score`, and `Math_Anxiety` as numeric. Name it *Student Assessments*.
This is 120 students across eight schools — three teachers per school, one at
each of grades 3–5. One quiet rough edge hides in here: student `S045`'s gender
is recorded as `M` where every other row spells out `Male`, so any chart of
`Gender` shows it as its own one-student category. An inline edit in the dataset
grid cleans it up whenever you run into it.

**3. Import the fidelity checklist.**
Import `fidelity_checklist.csv` as *Implementation Fidelity (May)*. Each of the
24 teachers has a classroom-observation `Fidelity_Score` (0–100), their
`Training_Hours`, and an `Observer_Notes` field. Three of those notes read "N/A"
— Mixed Measures treats "N/A" as missing, not as a category, which you'll see
reflected in the Data Quality tab.

**4. Import the school profiles.**
Import `school_profiles.csv` as *School Profiles* — one row per school, with
enrollment, the percentage of students on free or reduced-price lunch (`Pct_FRL`),
and the principal's last name.

**5. Append the earlier fidelity round.**
Open *Implementation Fidelity (May)* and use **Append** to add
`fidelity_december.csv` — an earlier observation round with the same columns.
The dataset grows from 24 to 48 rows. Look closely: two December rows use teacher
IDs `T3` and `T7`, where the rest of your data uses `T03` and `T07`. That
mismatch is the kind of join-key inconsistency real data is full of; you can fix
it with an inline edit so those two teachers line up.

**6. See which schools improved.**
A couple of quick moves in the Quantitative workspace tell the headline story:

- Add a **computed column** `Gain = Post_Score - Pre_Score` on Student
  Assessments. (Use a computed column, not a blank manual column — Mixed Measures
  fills it in for every row from the formula.)
- Run a **group comparison** of `Post_Score` by `School`, and another of `Gain`
  by `School`. Three schools (Maple Ridge, Brookside, Franklin) pull clearly
  ahead; Washington actually declines. Look closely at the group axis, though:
  *nine* groups, in an eight-school district. Two rows are misspelled `Frankin`
  — the same kind of stray value as the teacher IDs in step 5, and the same
  cure: fix the two cells with an inline edit and re-run, and the comparison
  settles to eight schools. (The Recode workbench's value counts catch it too —
  *Frankin · 2*. The finished reference project leaves the typo in place, so its
  headline ANOVA runs on all nine groups as imported.)
- A handful of `Post_Score` values are missing, all concentrated in the
  lower-performing schools. The **Data Quality** tab shows the missing-value
  summary and that the gaps aren't random — itself a finding.
- On the fidelity dataset, a **correlation matrix** of `Fidelity_Score`,
  `Training_Hours`, and `Years_Experience` shows training hours and fidelity
  moving together tightly. Schools that trained their teachers implemented the
  program faithfully.

So the numbers raise the real question: *why* did some schools pull ahead?

---

## Part 2 — The qualitative strand: why?

**7. Import the principal interviews.**
Import all eight `pi_*.csv` files as conversations. Map `Speaker` → speaker,
`Text` → text, and `Start` / `End` → the timestamps. Mark *Interviewer* as the
facilitator in each. Name them by school, e.g. *PI – Maple Ridge (Thomas)*.

**8. Import the teacher focus groups.**
Import the four `fg_*.csv` files as conversations (`Speaker` → speaker, `Text` →
text; no timestamps). Two files label the facilitator "Moderator" and two say
"Facilitator" — normalize them all to **Facilitator** as you map speakers, so the
four conversations stay consistent.

**9. Import the program documents.**
Import `trailhead_implementation_guide.txt` and
`district_curriculum_report.docx` as documents, with paragraph segmentation. The
guide is the publisher's reference (it's where the 24-hour training minimum comes
from); the report is the district's own year-one write-up, charts included.

**10. Build a codebook.**
In the codebook, create a handful of categories and codes that capture the
themes you expect — for example:

- *Implementation Quality* — curriculum fidelity, pacing, materials use,
  reversion to old methods
- *Training & Professional Development* — training adequacy, coaching, peer
  collaboration
- *Leadership & Support* — principal engagement, classroom walkthroughs,
  protected planning time
- *Barriers* — competing priorities, material delays, staff turnover
- *Teacher Attitudes* — buy-in, skepticism, feeling unsupported

You don't need to match these exactly; the point is to give yourself a vocabulary
before you start reading.

**11. Code the transcripts.**
Work through the interviews and focus groups, applying codes to the passages that
matter. A pattern emerges fast: the high-gain principals describe *protected
training time* and *regular classroom walkthroughs*; the struggling schools
describe *cancelled training*, *competing initiatives*, and, at Roosevelt, a
*staff-turnover* crisis that derailed everything. You can code the document
paragraphs and even the open-ended observer notes the same way.

**12. Link the principals to their schools.**
On the Participants page, create a participant for each of the eight principals
and link each one to the matching row in *School Profiles* (the `Principal` last
name is the key). Now a principal is one identity across their interview and
their school's numbers.

---

## Part 3 — Integration: bring the strands together

**13. Recode math anxiety so it points the same way.**
`Math_Anxiety` is scored so that *higher = more anxious*, which runs opposite to
the test scores. Apply a **ScaleMap** recode that flips it
(`1→5, 2→4, 3→3, 4→2, 5→1`) so higher means *less* anxiety, matching the
direction of `Post_Score`. Now the two can be compared and correlated cleanly.

**14. Build the canvas.**
Open the canvas and lay out the argument with at least three themes:

- **Assessment Outcomes** — the `Post_Score`-by-school comparison, plus a few
  excerpts from the high-gain principals.
- **Implementation Barriers** — the coded excerpts from the struggling schools'
  focus groups and interviews.
- **The Training Gap** — the guide's 24-hour minimum set against the actual
  training hours, which were far lower in the schools that fell behind.

Drag the cards, draw relationships between them (one theme *explains* another,
the fidelity numbers are *confirmed by* the interviews), and write a short
introduction. The canvas is where the quantitative "what" and the qualitative
"why" become a single, defensible finding: **the schools that improved are the
ones that trained their teachers and protected the time to teach the program
well.**

---

## Where to go next

- Open the **finished project** to compare your build against a reference.
- Try exporting an **R script** from any analysis — it reproduces the same
  numbers, so you (or a reviewer) can check the work independently.
- Swap in your own data: the same shape — datasets, transcripts, a shared
  codebook, a canvas — works for any mixed-methods study.
