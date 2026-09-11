# Changelog

All notable changes to Mixed Measures are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.2] - 2026-09-11

### Added

- **A document can now say who it is about.** Right-click a document in the
  Documents list and choose *Set subject…* to link it to a participant — a
  person, an organisation, a department, whatever the project's cases are. Once
  linked, coding on that document can be compared by the subject's attributes,
  exactly as conversations and survey responses already could; a document's
  coding was previously invisible to those comparisons because a document has
  no speaker to reach a participant through. The card shows who it is about,
  the participant's own page lists the documents about them, and one
  participant can have any number of documents (successive annual reports, an
  interview plus the artefacts filed with it). Documents can be unlinked again
  at any time. (Roadmap row 46)

- **Withdrawal reports now include documents.** A participant's withdrawal
  report counts the documents about them alongside their conversations and
  survey responses. When a withdrawal is carried out, those documents are
  **unlinked and listed for review** rather than deleted or blanked — a
  document that is *about* someone may be their own work or may simply name
  them, and only a person can tell which, so the tool removes the identifying
  link and hands the list back.

- **A participant table: rating scores become variables.** The Datasets page
  offers *Add participant table* — a table the tool keeps in step with the
  project's participants, one record per participant, keyed by their
  identifier. For every code that declares a rating scale it maintains two
  columns: *{code} (score)*, the mean of that person's per-passage ratings, and
  *{code} (rated passages)*, how many passages that mean rests on — kept as a
  variable of its own so that a score over eight passages and one over a single
  passage are never the same evidence. Each passage's rating is the median of
  the coders who rated it: a single-coder project scores from that coder's
  judgement, and a multi-coder one from the passages the team agreed carry the
  code. Because the scores are ordinary columns, the analysis pickers, group
  comparisons, charts, the crosswalk and the R export pick them up with no
  further step. The table is a snapshot: it states when it was computed, an
  amber marker warns when something it depends on has changed since, and
  *Refresh* recomputes every score and reports what it could not score and why
  — a rating on a video clip, a facilitator's own turn, a speaker or document
  not yet linked to a participant, a code the coders did not agree applies.
  The rows belong to the tool (they cannot be deleted, appended to from a
  file or re-linked), the columns are yours: add variables, edit the cells in
  them, rename, export. (Roadmap row 45)

- **A table you can build by hand.** *Blank table* on the Datasets page creates
  a dataset with no file behind it, and *Add ▾ → Add record* on either tab of a
  dataset adds one empty record; the variable menu adds the columns. The case
  it serves is the small lookup table that exists nowhere as a file — ten
  departments and three columns — which until now had to be built in a
  spreadsheet and imported. A hand-authored table is an ordinary dataset with
  every affordance. A new record takes the next identifier after the highest
  one in the table, and lands after imported rows rather than ahead of them;
  an empty table shows its headers and says what it still lacks instead of a
  blank page. (Roadmap row 47)

### Changed

- **The Excel export's "Summaries" sheet is now "Sources", without the empty
  Summary column.** That column could never hold anything: the panel that wrote
  summaries was removed from both workbenches months before the first release,
  and no version you could have installed was able to fill it in. An always
  blank column in an exported workbook reads as data you forgot to enter. The
  sheet keeps everything else it listed, one row per conversation and document
  with its type, name, subject, date and status, and is named for that. The
  summary field is also gone from the API and no longer searched. Nothing is
  deleted from your projects: the underlying storage is untouched, so a summary
  feature could return without any conversion. (#895)

### Fixed

- **Setting a document's subject no longer moves the card or loses your place.**
  Choosing who a document is about sent its card to the top of the list and left
  the keyboard at the top of the page, which is awkward on a job you do to
  several documents in a row. The cause was an ordering one: documents imported
  together share a creation time to the second, and the list fell back to the
  order the server happened to send, which changes whenever a document is
  touched. The list now has a settled order that does not move, and focus
  returns to the card you opened the menu on. The Conversations list gets the
  same settled order. (#932)

- **The merge wizard tells you which step you are on.** Moving between steps kept
  the previous step's scroll position, so the Review step could open with its
  heading behind the toolbar, and the keyboard was dropped back to the top of the
  page each time. Each step now announces itself and takes focus when it opens.
  The review table's legend also explains the dash, which is what every row shows
  when the two codebooks already agree — it means the file brings nothing new for
  that code. (#935, #945)

- **A brand-new table's two buttons are no longer cut off at high zoom.** At the
  size a 1280 by 720 window has at 200% zoom, the *Add variable* and *Add record*
  buttons on an empty table were partly behind the status bar with nothing able
  to scroll to them. The panel scrolls within its own area now. The status bar on
  that screen also stopped telling you to click a column header or a cell, on a
  table that has neither. (#930)

- **The participant table no longer shows two columns headed "Participant".**
  One was the grid's own column showing each person's name, the other the
  tool's column showing the identifier they are matched by. The second is
  headed *Participant ID* now, so each says which it is. Tables made before
  this are corrected the next time they refresh, unless you renamed the column
  yourself, in which case your name is kept. (#928)

- **A participant score column reads the same way all the way down.** Scores
  were shown at their shortest, so one column ran `3.643 / 1.25 / 4.167 / 2`
  with nothing lining up and a whole number looking like a different kind of
  value. Scores now carry a fixed three decimal places and the count of rated
  passages beside them stays a whole number. The stored figures are unchanged.
  (#942)

- **The Data view calls a row a record, everywhere.** Deleting one asked
  *"Delete response?"* and promised to remove *"all their answers"*, which is
  wrong for a table of departments or sites. The confirm, the message afterwards
  and the Code Text tooltip all use the word the rest of the surface uses. The
  *Add Variable* dialog follows too: its fields were labelled *Column label* and
  *Column code* and its button said *Add Column*. (#940)

- **A new variable no longer defaults to a rating scale on a table that has no
  survey in it.** Adding the first variable to a hand-made table offered
  Ordinal, with *Strongly Disagree … Strongly Agree* suggested underneath, on
  exactly the reference tables the blank-table dialog describes as sites,
  cohorts or departments. The default follows the table now: Categorical where
  nothing was imported, Ordinal where a file was. (#941)

- **The record counter no longer reads "1 records".** The caption below it had
  been correct since an earlier fix; the toolbar had not. (#939)

- **An imported project no longer forgets which code each rating score belongs
  to.** A participant table keeps a hidden note on every score column saying
  which code it scores. That note was not translated when a project was imported
  or shared, so the columns arrived pointing at codes from the original copy. In
  the ordinary case the next refresh quietly rebuilt them, taking any chart built
  on them with it; on a colleague's machine, where the numbering can overlap, a
  column could have been filled with a different code's scores while keeping the
  first code's name. The note is translated on the way in now. A score column
  whose code did not travel with the file is left out altogether rather than
  imported as something nothing can repair, and the next refresh rebuilds it from
  the codes the project actually has. The same gap is fixed for charts that break
  a variable group into its individual variables. (#922, #948)

- **Deleting a code no longer leaves a broken chart behind.** When a code is
  deleted, the participant table drops the score columns that measured it —
  there is nothing left to compute them from. Anything you had built on those
  columns, a chart or a saved test, stayed behind pointing at a variable that no
  longer existed and failed with an error the next time it was opened. Those are
  now removed with the column, and the refresh tells you how many went, so a
  chart disappearing is something you are told about rather than something you
  discover. (#923)

- **A dataset or a variable can no longer be saved with a blank name.** Typing
  only spaces into a name was accepted and stored, leaving an unnamed table in
  your dataset list or an unnamed variable in every picker and export. Names are
  trimmed and a name that is only spaces is refused, on every path that sets one:
  creating a table, renaming one, importing a file, and adding or renaming a
  variable. The dialogs already prevented this; the gap was reachable by anything
  driving the tool directly. (#925)

- **A withdrawal report no longer counts a participant's own scores as answers
  they gave.** The participant table holds one record per person, so it appeared
  in the report beside their real surveys and its cells were counted as
  responses — telling you someone had answered three questions when they had
  answered none. Only cells in columns you added are counted now, and the row
  says how many values the tool maintains instead of leaving an unexplained
  empty count. The record is still reported and still removed on a withdrawal:
  under-reporting is the failure that matters here. (#896)

- **A data grid column header no longer reads its own name three times.** A
  screen reader announced the reorder handle's label, then the variable's name
  twice, then its type and, on a participant table, the whole sentence explaining
  how its score is calculated — for every cell in that column. The header now
  announces the variable, and the explanation stays available as a description.
  (#915)

- **Merging a colleague's copy no longer fails when you both have a participant
  table.** The table is the tool's own, so when two people each created one in
  their copy the merge treated them as two different tables and stopped with an
  error that named nothing and offered no way forward. They are now recognised
  as the same table: the rows are matched by person, and any variable your
  colleague added to their copy comes across with its values. Nothing was ever
  lost when this happened, the merge simply could not complete. (#921)

- **The participant table's own score columns can no longer be retyped or given
  rules.** Those columns are maintained by the tool, one for each code's score
  and one for the number of passages behind it. It was possible to change their
  type, declare value labels, declare missing values or attach a recode rule to
  them — and a type change survived a refresh, which quietly removed the score
  from every picker, comparison, chart and the R export while the tool carried on
  writing numbers into it. All four are refused now, and the controls say why
  rather than failing when you use them. Renaming the columns is still yours to
  do. (#926)

- **Text you typed into a table can be edited again.** In a table you author by
  hand, clicking an open-text cell that already had something in it opened a
  read-only viewer whose only button was Close, so a typo could be corrected only
  by deleting the whole record. Clicking now opens the editor, as it does for
  every other kind of value; the viewer stays for cells that come from an
  imported file and cannot be edited. Pressing Enter or F2 on a selected cell
  opens the editor too, which is what the rest of the app has always promised.
  (#927)

- **The variable editor is reachable at high zoom and from the keyboard.** At the
  size a 1280 by 720 window has at 200% zoom, the editor that opens from a column
  header ran off the bottom of the screen with its *Delete variable* item below
  the fold and nothing able to scroll to it. It also could not be opened without
  a mouse at all. The panel now fits and scrolls, the header carries a real
  button you can Tab to and open with Enter, and closing it returns you to that
  button. Each one names its own variable rather than saying "column options"
  eleven times. The *Unlink* control on a linked participant row had the same
  problem and now appears when it has keyboard focus. (#929, #931)

- **The Memos list's group headers are one control, not two overlapping ones.** A
  group header was a button with another button inside it: clicking the row
  collapsed the group and clicking the label inside it did something else, with
  only a hover underline to tell them apart. The row is now the collapse control
  and filtering to one entity is its own button beside it. On the Memos slide-out
  those inner controls did nothing at all when activated, which is why they are
  gone from there entirely. (#933)

- **Archiving a memo or a note no longer looks like deleting it.** The archive
  button carried the same trash icon as the permanent delete beside it and opened
  a red confirm, while the confirm's own words said the memo could be restored.
  It now has an archive icon and an ordinary confirm, and the red treatment is
  kept for the one control that earns it. The same correction was applied on all
  three places these controls appear, and the notes version, which had never been
  swept, also gained a proper name for screen readers. (#934)

- **Dark mode now covers the parts of the window the browser draws.** Scrollbars,
  drop-down popups and date, colour and number controls stayed in their light
  appearance, so a scrollbar rendered as a bright band across a near-black panel.
  Light mode is unchanged. (#936)

- **At high zoom the breadcrumb no longer covers the toolbar buttons.** On any
  project page with a three-level breadcrumb, the last part of the trail was
  drawn on top of the Search and Participants buttons, leaving all three
  unreadable. The trail now shortens with an ellipsis as it was meant to, and the
  separators between its parts hold their place. (#937)

- **Messages are readable in dark mode.** Every confirmation and error message
  appeared as a white card over the dark interface. They now follow the theme you
  chose in the app rather than the one your operating system is set to. (#938)

- **Creating a memo tells you it saved, and shows it to you.** Memos are grouped
  by what they are about and groups start collapsed, so a memo you had just
  written disappeared into a closed row with no message. Creating one now
  confirms it and opens the group it landed in. The "no memos yet" line also
  stops appearing underneath the form you are typing in. (#944)

- **Opening the app no longer overwrites your migration recovery points.**
  Before a database upgrade the app copies your whole database, so that a
  failed upgrade can be undone. That copy was in fact being made every time
  the app started, whether an upgrade was due or not, and only the five most
  recent are kept. So five ordinary launches after a bad upgrade would discard
  the one copy taken before it, which is the situation the copy exists for. It
  is now made only when an upgrade is actually pending. Startup is quicker and
  quieter as a result, and on a large project noticeably so. (#920)

- **The safety copy taken before a merge or an overwrite is now findable.**
  Replacing a project with an imported file, or merging a colleague's coding
  into one, has always saved a full copy of your project first. Nothing ever
  told you what that copy was called: it is a project file rather than a
  backup archive, so it does not appear in the Settings backup list, and the
  only way to find it was to guess. The merge summary and the overwrite
  confirmation now name the file and say how to go back to it, and the name is
  recorded in the project's activity log, which is where you will be looking if
  you need it days later. A merge's copy is also named for a merge now, rather
  than describing itself as preceding an overwrite that never happened.

- **A long coder name wrapped onto two lines in the top bar, and narrow
  windows scrolled sideways.** The name beside the colour dot is meant to
  shorten with an ellipsis when it does not fit; instead it wrapped, which grew
  the button taller than the bar that holds it. Separately, at around 640 pixels
  wide the name was shown when there was no room for it, so the whole page could
  be scrolled a few pixels sideways. The name now appears only when the bar has
  room to hold it at full width, which it decides from its own width rather than
  the window's, so a scrollbar no longer tips it over. Below that width the name
  is hidden from view but still announced to screen readers, as before. (#899)

- **A record added after a variable existed could not be typed into.** In
  three situations a row had no cell for a variable created before it — a
  participant added to the participant table after a variable was added by
  hand, a file appended to a dataset that has a hand-added variable the file
  lacks, and rows arriving through a project merge — and the grid discarded
  every edit to that cell with no message and no request. Every row now gets
  its cells, and rows already in that state are repaired the next time the
  dataset gains a row. (#897)

- **Renaming or describing a dataset left no trace in the activity record.**
  The entry was written after the change was saved and then discarded, so the
  audit log a project export can include, and the last-activity time on the
  project card, never saw a dataset rename. They do now. (#898)

- **Seven font-size pickers under Chart Options had no name.** The *Label*,
  *Ticks*, *Data* and *Title* size pickers on the Quantitative chart options,
  and the three on the Qualitative ones, announced only their current size to
  a screen reader. Each carries its caption now. (#900)

- **Four selects on the analysis sidebar were named only by the caption above
  them.** *Compare By*, *Secondary Grouping*, *Color Palette* and *Matrix
  Colors* under Relationships & Comparisons announced no name. They do now.
  (#901)

- **Import wizards: nameless and misnamed controls.** On Dataset Import, the
  column-type selects announced only their value, and the skip checkbox's
  spoken name included the type select's current value and changed with it.
  On Conversation Import, the four Map Columns selects had no name and the
  required ones said nothing about being required; every speaker row's
  controls shared one name (six *Facilitator* checkboxes, six colour buttons);
  and the *Conversation Name* field announced its example text, as did Dataset
  Import's name, description and source fields, while Document Import's name
  field had no name at all. Every control names its column, speaker, file or
  field now, and a required field says so. (#902, #903, #904, #905)

- **The *Axis range* minimum and maximum inputs shared one label.** The
  minimum's spoken name absorbed the maximum's value and the maximum fell back
  to the word *Auto*. Each is named now. (#906)

- **Memos & Notes: the hidden pane stayed in the keyboard's Tab order.** With
  one view selected, the other pane's six filter buttons could still be
  reached by Tab while a screen reader was told they did not exist. The
  collapsed pane is inert now. (#910)

- **The memo button on the coding workbenches said *Delete* but archived, and
  hid from keyboard users.** It is named *Archive memo* followed by the memo's
  opening words, and it stays visible while it has keyboard focus. The four
  memo actions on the Memos page (archive, edit, restore, delete permanently)
  each name their memo too. (#912)

- **Editing a cell in the data grid announced nothing useful.** The drop-down,
  number and text editors had no spoken name and the long-text editor said only
  *Edit cell value*; each now names the variable being edited. (#914)

- **Four smaller naming fixes from the same accessibility pass:** the *Add
  participant table* button now announces its visible label (the explanation
  is its description, #907); the *All …* filter tab on the Conversations,
  Documents and Datasets lists no longer runs its count into its label
  (#908); the data grid's caption pluralises correctly for one column or one
  record (#909); and the merge wizard's eight coder-mapping drop-downs are
  named *Bring in ‹coder› as* (#913). The *Add Variable* dialog also stops
  pointing screen readers at a description that was never rendered (#911).

- **The variable list in the analysis sidebar could be drawn on top of the
  controls below it.** On Relationships & Comparisons, expanding a dataset
  squeezed the variable list to nothing while its search box and tabs kept
  drawing where they were — so the Correlations/Comparisons buttons and the
  Data options were rendered over them and both became unreadable. It happened
  at ordinary window sizes, and appeared to strike at random because expanding
  a dataset is what triggered it. The sidebar now scrolls as a whole, each
  section keeps its own height, and the variable and group lists scroll within
  a bounded area. Section headings stay pinned while you scroll. (#894, #529)

- **Comparing two canvases no longer offers to change them.** The comparison
  view is a read-only diff, but each embedded chart, quote, memo, callout and
  image still showed a working *Remove from canvas* button, an *Add tag*
  button, and a *Remove from Theme* item in its right-click menu. Those are
  gone while comparing. A tag that has already been applied stays visible —
  it is part of what you are comparing. (#893)

### Security

- **Updated the YAML parser inside the desktop app's update checker** (js-yaml
  4.3.2). The new version bounds the work a crafted update feed could make the
  parser do. The feed comes from this project's own release page over TLS, so
  the practical exposure was low; the fix is a dependency bump with no change
  in behaviour. (#918)

## [1.5.1] - 2026-09-06

### Added

- **Ratings on observation clips and text responses.** The rating strip that
  1.5.0 offered on conversation and document transcripts now opens on the
  observation workbench and on Text Coding too — after applying a code that has
  a scale, from the keyboard, the row menu or the chip's `+`. On every coding
  surface, **`r`** re-opens the strip for a code you have already applied, and
  the row's right-click menu lists a *Rate "…"* item per ratable code. The
  keyboard-shortcuts dialog and the status bars name the key.
- **Ratings on text responses reach the study workbook.** The `Ratings` sheet
  gains rows for dataset-cell ratings, named by dataset and column, with a new
  trailing `Record` column carrying the response's record identifier.
- **The import preview counts canvases.** The "what's in this file" summary
  shown before a `.mmproject` import now lists canvases beside conversations,
  documents, datasets and observations. The count had been written into every
  exported file since the canvas shipped and never reached the preview.
- **Four configuration variables are documented.** `MM_AUTO_BACKUP_INTERVAL_HOURS`,
  `MM_AUTO_BACKUP_MAX_COUNT`, `MM_SESSION_EXPIRE_HOURS` and `MM_CSRF_ENABLED`
  have been honoured for months and named nowhere; they are in the README's
  configuration table now.
- **Codebook files carry rating scales.** A `.mmcodebook` export now includes
  each code's declared rating scale, and importing one declares it on the new
  code (the import result says how many arrived with a scale). The REFI-QDA
  `.qdc` format has no place for a scale and stays without one.
- **Merging codes says what happens to ratings, before and after.** The merge
  dialog notes when two codes have different rating scales, or when the code
  you keep has none; the confirmation names any rating differences flagged for
  reconciliation and any ratings kept on a code that cannot show them yet.
- **Merging a colleague's project says when scales differ.** The reconcile
  step shows each incoming code's rating scale and warns when folding it into
  one of yours would cross scales; the final report counts the ratings that
  did not fit.

### Fixed

- **Merging one code into another could put ratings outside the target's
  scale.** The merge now refuses, naming how many ratings would not fit and
  what to do, instead of moving them silently; a duplicate application's
  differing rating is kept as a reconciliation difference rather than deleted.
- **Merging a colleague's project could import ratings the receiving code's
  scale cannot hold.** Such a rating now arrives as a flagged difference on an
  unrated application, never as a rating, and non-numeric values in the file
  are dropped rather than stored.
- **Participant actions now say whose record they act on.** On the Participants
  page every row offered *Edit*, *Remove this participant's data* and *Delete
  record* under those exact words — thirty rows, ninety controls, none naming
  the person. A screen-reader user had no way to tell whose withdrawal request
  they were about to send. Each names the participant now.
- **Two "Expand" controls said only "Expand".** The category rows in the
  qualitative code picker and the dataset rows in the codebook's hide panel gave
  no clue which section they opened; they name it now.
- **A value-label row could be announced as invalid with no reason given.** When
  the editor was set to stay quiet until you type a label, an untouched row was
  still marked invalid and pointed at an explanation that was not on screen.
- **Four controls announced as an unlabelled "button".** Moving between documents,
  the previous/next arrows and the document picker had no spoken name — the
  arrow at each end of the list was silent even to a mouse-over tooltip. And
  when editing a code's description, the tick and cross that save and discard
  the edit were indistinguishable to a screen reader. All four are named now.
- **A screen reader did not hear the merge dialog's rating-scale warning.** The
  note explaining what happens to ratings when two codes are rated on different
  scales was on screen but was replaced by the words "Rating scales" when the
  dialog and its Merge button were announced. The full sentence is now read out
  on both — the warning matters most on an action that cannot be undone.

- **Six controls that told a screen reader nothing.** The sort controls on the
  Conversations and Documents lists, the File Encoding chooser when appending to
  a dataset, and both target choosers in the Memos panel's new-memo form
  announced only their current value and no name at all. They are named now.
- **Every "Quote" button on the Text Coding view said only "Quote".** With
  fourteen responses on screen, a screen-reader user heard the same word
  fourteen times with nothing saying which response each one acted on. Each
  names its record now (or, in the By Record view, its column). (#892)

- **Removing a code from a text response could delete a colleague's coding.**
  In a multi-coder project, the single remove gesture on Text Coding was not
  scoped to the coder making it and could remove the lowest-numbered coder's
  application instead of your own. It now removes only yours. (#879)
- **A rating given quickly after applying the code could show as "not rated".**
  On documents and observations, a rating committed before the apply had
  finished refreshing the page was overwritten by that refresh; the server had
  the rating, the chip did not. (#881)
- **Undoing twice in quick succession on an observation could leave a deleted
  code on screen** until the page was reloaded. (#881)
- **One refused undo could jam undo for the rest of the session.** If the app
  declined to reverse a step — for example a rating on a code no longer applied
  to that segment — the history stopped there: every later Ctrl+Z retried the
  same impossible step and nothing behind it could be reached again without
  reloading the page, which discarded the history anyway. A step the server
  settles is now dropped from the history, and says so; a step that failed for a
  passing reason, like a dropped connection, is kept so you can retry it. (#874)
- **Coding quickly could silently discard a code.** While one action was still
  saving, the next was dropped with no request and no message — pressing two
  code keys in succession at ordinary coding speed applied one and lost the
  other. Actions are now queued and applied in order. (#877)
- **Undoing a code removal could bring the code back without its rating.** The
  chip's `×` and the multi-clip removal on the observation workbench both
  re-applied the code bare. Every removal door now restores the rating it
  captured. (#875, #876)
- **A code's rating bar could stretch across the whole page** on the
  reconciliation grid — every other coder's cell and the consensus cell, on the
  one screen whose job is comparing ratings. (#878)
- **Two screens had no room for content at 200% zoom.** The Text Coding view and
  the observation workbench filled the entire window with their own toolbars, so
  no responses or clips were visible at all. Both now show their content at that
  zoom level, with nothing hidden at normal window sizes. More of this work is
  still to come. (#880)

### Security

- **Updated the rich-text editor behind the Canvas** (Tiptap 3.31.3, which
  carries prosemirror-view 1.42.3) — the new version fixes a clipboard
  vulnerability in the editor's paste handling. The Canvas is a paste target, so
  the fix applies directly. (#872)

## [1.5.0] - 2026-09-02

The reliability release. Two features that go together: every reliability
coefficient now reports how precise it is, and a code can carry a rating scale
so coders can record *how much* — with agreement on those ratings measured the
same way agreement on the codes themselves is. Recode rules also learn to band a
continuous variable into groups.

### Added

- **Confidence intervals on the reliability coefficients.** Cohen's κ carries an
  analytic 95% interval and Krippendorff's α a cluster-bootstrap one, shown inside
  the Reliability tab's cells, with a note when the interval spans an
  interpretation cutoff. Unitizing α and time-binned κ deliberately report no
  interval, and say why.
- **Magnitude coding.** A code can declare a rating scale (minimum, maximum, step,
  anchor labels), and a coder rates each application on it — "how much does this
  segment have this characteristic?". Unrated is a real state, never a zero. The
  Reliability tab gains a second table with one interval-metric α per rated code;
  the consensus layer carries the median rating and flags coders who differ by
  more than one step; the reconciliation grid gains *Ratings differ* and *Merge
  difference* review states; the coded-segments CSV gains three trailing columns
  and the study workbook a `Ratings` sheet. **In this release the rating control
  is offered on conversation and document transcripts; observation clips and text
  coding display ratings but cannot give them yet.**
- **Range bands in recode rules.** A rule can band a continuous variable
  (`18–24 → 1`, `25–34 → 2`, …) with inclusive, optionally open-ended bounds.

### Upgrade notes

- **Project files saved by this version do not open in 1.4.0 or earlier.** The
  `.mmproject` format is now version 6 (range bands and ratings are part of the
  file); older files still open here. A colleague on 1.4.0 cannot open a project
  you export from 1.5.0 — you both need 1.5.0 before exchanging `.mmproject`
  files. **`.mmbackup` is unaffected.**
- **Your database is upgraded on first launch, and a backup is taken first.** The
  upgrade adds empty fields for code rating scales, the ratings themselves, and
  recode range bands; it changes none of your existing data. As always, the
  automatic pre-upgrade backup is kept only for the five most recent launches —
  if you want a copy you control, take one before updating (Settings → Backup &
  Data).

### Changed

- **A refused action now says why.** When the server declines something with a
  reason — a rating on a retired code, a scale change that would strand existing
  ratings, changing the type of a variable that has a recode rule on it — the
  message shows that reason instead of a bare "Action failed".
- **Very large projects can now be shared, duplicated and merged.** The
  `.mmproject` limit was **500,000 dataset values**; it is now **4,000,000**.
  Both halves of the round trip were rebuilt to get there, because fixing only
  one produces a file that takes half an hour to read back. Measured on a real
  75,699-record survey with 41 questions (3.6 million values): exporting went
  from about two minutes to **80 seconds** and now uses a small fraction of the
  memory, and re-importing that file went from **26 minutes to under three**.
- **Importing a project no longer freezes the rest of the app** while it runs,
  and neither does exporting or duplicating one.

### Known limit

- **Memory on very large project files.** Reading a `.mmproject` file still holds
  the whole file in memory while it is unpacked — about 2.6 GB for a 3.6-million-
  value project. That is now the thing that limits project size, rather than time.
  It affects sharing and merging only; **`.mmbackup` is unaffected at any size.**

## [1.4.0] - 2026-08-27

A corrective release, and a large one. Most of it is work that makes existing
features hold up on real research data — a 75,699-record survey, a fully coded
transcript, a project with hundreds of variables. The dataset workspace is
reorganised into two views, recoding can now produce a new variable instead of
overwriting the old one, and several numbers the app reported are now correct.

### Upgrade notes

- **Your database is upgraded on first launch, and a backup is taken first.**
  This release adds two fields recording where a derived variable came from. The
  upgrade is quick even on very large projects, and it does not change any of
  your data. As always, the automatic pre-upgrade backup is kept only for the
  five most recent launches — if you want a copy you control, take one before
  updating (Settings → Backup & Data).
- **Project files are unchanged.** `.mmproject` and `.mmbackup` files work in both
  directions with 1.3.2. A colleague still on 1.3.2 can open a project you export
  from 1.4.0; they will simply not see the new "derived from" note on variables.
- **The recoding page moved.** It is now *Variables*, alongside *Data*, on every
  dataset. Old links and bookmarks redirect automatically.
- **Applying a recode rule is now something you ask for.** Previously, saving your
  first rule for a variable applied it immediately, and deleting the rule in
  effect could rewrite the variable's numbers again. Neither happens now — see
  *Changed*.

### Known limit

- **Very large datasets and project files.** Projects containing more than
  **500,000 dataset values** cannot yet be exported as a `.mmproject` file, and
  Mixed Measures will say so rather than failing part-way. Datasets themselves can
  still be imported and analysed well past that point. **Your backups are not
  affected** — `.mmbackup` works at full size, so your data stays protected. What
  this limit reaches is *sharing* a project with a colleague, *duplicating* one,
  and *merging*. Raising it needs both halves of the round trip rebuilt together,
  and that work is scheduled for the next release.

### Added

- **A dataset now has two views: Data and Variables.** *Data* is the grid of
  records. *Variables* is where a variable is described — its name and label, its
  type, its value labels, which values count as missing, and its recode rules —
  with the rules visible on screen while you edit the dictionary.
- **A recode rule can produce a new variable, leaving the original untouched.**
  Choose *Recoded variable…* from the *Add* menu on the Data view, or derive from
  a rule in the Variables view. The new variable records which variable and which
  rule produced it.
- **Histograms, box plots, and Q–Q plots.** A continuous variable draws a
  histogram rather than one bar per distinct value; group comparisons draw a box
  plot; and the Q–Q plot states the plotting convention it used.
- **A frequency distribution states its margin of error.**
- **Reliability reports per-item diagnostics** — alpha if each item were dropped,
  and item-total correlations — and no longer reports an undefined coefficient as
  zero.
- **The comparisons panel says whether you need the non-parametric test**, rather
  than leaving the assumption checks for you to interpret.
- **Declare one missing-value vocabulary across many variables at once.** Survey
  exports typically use the same handful of codes for "Refused", "Don't know" and
  "Inapplicable" in every column; declaring them one variable at a time was the
  only option before.
- **A withdrawal report.** For a given participant, the app can now say what data
  traces back to them and where it lives — counts and locations, never the text —
  and honour a withdrawal by redacting rather than deleting the links that make
  the request answerable in the first place.
- **Jump to a record, and land on it from search.** A record number takes you
  straight to its page in a large dataset, and a search hit opens the record it
  found rather than the first page.
- **Re-derive a variable whose source has drifted**, and re-key a rule that a
  relabel invalidated, instead of rebuilding either by hand.

### Changed

- **Applying a recode rule to the variable it sits on is now a deliberate act.**
  Three paths used to apply a rule without asking: saving the first rule for a
  variable, deleting the rule in effect, and promoting another. A rule in effect
  rewrites every stored number in its variable and there is no undo, so it is now
  something you choose — *Apply to this variable…* — and the rest leave your
  numbers exactly as they are. Value labels are unaffected; they work as before.
- **Every saved rule says whether it is in effect** — "In effect" or "Not
  applied" — where before there was an unlabelled star.
- **Imports are limited by cells, not file size.** The limit is 4,000,000 cells
  (records × variables), which is the thing that actually costs time and memory;
  a file's size in megabytes varies four-fold between formats for identical data.
- **Declared-missing values are now blank in R and Excel exports**, and the data
  dictionary carries a Missing Values column so the distinction between "Don't
  know", "Refused" and "Inapplicable" is not lost. The two exports previously
  disagreed about which cells counted.
- **Exports are given up to 15 minutes.** A large Excel export could take longer
  than the app was willing to wait, and a successful export was being discarded
  after the fact.

### Fixed

- 🔴 **Statistical tests could not run in the installed app at all, and now can.**
  In 1.3.1 and 1.3.2, every group comparison — t-test, ANOVA, Mann-Whitney,
  Kruskal-Wallis — failed with a server error in the packaged desktop app. The
  statistics library was not fully included when the app was bundled, and the
  missing piece was only reached the moment a test ran, so nothing detected it
  until the app was installed and used. Descriptive statistics, frequencies,
  charts and everything else were unaffected. **If comparisons have been failing
  for you, this release fixes it** — no change to your data or projects is needed.
- **Large surveys work end to end.** A real 75,699-record, 41-variable survey
  could not be previewed, imported, opened, or deleted. All four are fixed:
  previewing no longer times out, importing writes in batches instead of one
  round trip per record, opening a dataset loads a page at a time, and deleting
  is handed to the database rather than loading every row to delete it.
- **A long export no longer freezes the whole app.** Running a large export made
  every other part of Mixed Measures unresponsive for the duration — over three
  minutes in the worst measured case, now under eight seconds.
- **Text Coding no longer fails on a dataset with several open-text variables.**
- **The qualitative coverage figure was wrong on fully coded text.** A column
  where every substantive response had been coded reported 90%, because cells the
  workbench hides by default were counted in the total but could never be coded.
- **Canvas: comparing a snapshot showed one theme's text under another theme's
  heading**, and comparing against a snapshot that had rotated out drew a
  difference it had not actually established.
- **The Variables view's detail pane had no surface of its own**, so it showed
  through to the page behind it — grey in light mode, and the darkest region on
  screen in dark mode.
- **Relabelling a variable is refused when the stored number is not the code the
  label implies**, which would otherwise have rewritten responses to their
  opposite.
- **A declared answer option nobody chose is now a row of the cross-tabulation,
  but not a row of the test** — chi-square and Cramér's V run on what was
  actually observed.
- **Chi-square says when its approximation is unreliable** rather than reporting
  a p-value that should not be read.
- **A codebook exported by QualCoder was rejected** because of an invisible
  marker at the start of the file.
- **R exports: a factor's levels are written in the same form as the data**, so a
  variable no longer silently arrives empty in R.
- **A saved figure records the filters it was saved under**, so reopening it does
  not silently show a different population.
- **Accessibility:** the variable list, saved rule cards, and every rule action
  are reachable from the keyboard; several controls that were announced only by a
  tooltip now have real names; and the toolbar no longer scrolls out of reach at
  200% zoom.

## [1.3.2] - 2026-08-15

A security and packaging patch. There is no new capability here and nothing in
your projects changes. **Linux users should update**: the AppImage published up
to and including 1.3.1 could load code from the folder it was launched from.

### Upgrade notes

- **Linux (AppImage): please update, and prefer launching from a folder only you
  can write to.** Every Mixed Measures AppImage up to 1.3.1 was built with a
  packaging tool that wrote a startup script placing the *current working
  directory* on the system library search path. Anyone able to write a file into
  the folder you launch the AppImage from could therefore have had their code
  loaded into the app. This was a defect in the build tool, not in Mixed Measures'
  own code, and it is fixed by rebuilding with the corrected tool — so it is fixed
  simply by installing 1.3.2. There is no sign it was exploited, and it did not
  affect the Windows or macOS builds.
- **Windows: this release changes how updates verify their signature.** The
  publisher name the updater checks a download against moved as part of the
  packaging upgrade. Updating to 1.3.2 works normally; the change matters for
  updates *after* it.
- **Everyone else: nothing to do.** No database migration, no format change, and
  `.mmproject` / `.mmbackup` files are unaffected in both directions.

### Fixed

- **Linux AppImage: arbitrary code could be loaded from the launch directory**
  (CVE-2026-54672, high). The generated startup script set `LD_LIBRARY_PATH`,
  `PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR` with a trailing empty entry,
  which the dynamic linker resolves to the current directory. Fixed by upgrading
  the packaging toolchain; the corrected script guards every one of those
  variables.
- **The "could not start" dialog mangled non-English folder names.** When the
  backend failed to start, the recovery message names the folder it could not
  open — and any character outside the Windows default encoding was replaced or
  dropped, so the dialog could point at a path that does not exist. It now
  carries its own text encoding end to end. A folder name containing a
  non-breaking space was corrupted by a separate bug in the same message and is
  fixed too.
- **Merging a colleague's copy of a project no longer accepts edited transcripts.**
  If two people held the same project and one corrected the wording of a segment,
  a merge would keep one side's text while re-anchoring the other side's
  highlights onto it — silently attaching quotes to words nobody had quoted. The
  merge now refuses, names the affected segments, and asks which text is correct.

### Changed

- The desktop packaging toolchain (electron-builder) was upgraded a major
  version, and the Python bundler is now pinned exactly so a given release is
  always built by the same toolchain.

## [1.3.1] - 2026-08-14

A correctness and accessibility release. No new capability to speak of — this
fixes numbers that were wrong or wrongly labelled, finishes the qualitative
Canvas that 1.3.0 shipped with a stated limitation, and makes a large part of the
app reachable without a mouse.

### Upgrade notes

Please read these before updating. Several of them change numbers you may
already have written down or reported.

- **If you reported an effect size from a group comparison, check which
  statistic it was.** The comparison table chose its effect-size heading from the
  **number of groups** while the number itself came from the **test that ran**.
  Where those disagreed — a Welch's t-test across three groups is the common
  case — the table showed Cohen's *d* under an ω² heading, and the tooltip
  described it as a negative η². The heading, the tooltip and the value now all
  come from the test. Nothing about your data changed, but a figure copied from
  that table may be labelled with the wrong statistic.
- **The group-comparison CSV and the screen now report the same effect size.**
  The export wrote η² while the screen showed ω². If you have both a file and a
  screenshot from the same analysis, they will have disagreed; the file now
  matches the screen.
- **Significance stars in exports now follow the thresholds you chose.** The CSV
  always marked significance at the conventional .05/.01/.001 levels regardless
  of the levels set for the analysis. If you changed those levels, the stars in
  files exported before this release do not reflect them.
- **A statistic that cannot be computed now says so instead of showing `0.00`.**
  A correlation with too few values, a comparison with an empty group, a test on
  data with no variance — all previously displayed `0.00`, which reads as *no
  relationship* when the truth is *not computable*. These now show `—` with the
  reason. **Re-check any table where you recorded a zero:** some of those zeros
  were real measured zeros and some were this.
- **A scale score now states what it averaged and over how many people.** A
  crosswalk scale score is the unweighted mean of its items' means. It previously
  showed a single pooled *n* that summed each item's respondents — so a score
  built from a 1,000-response item and a 10-response item quoted *n* = 1,010,
  when no single estimate rests on 1,010 people. It now reads `3 items · n
  210–260`, with the pooled total named as a total in the tooltip. The figure
  labelled "95% CI" is computed **across items**, not across respondents, and is
  now labelled as such — any confidence interval reported from a scale score
  should be re-described. The score also now warns when its items are measured on
  different scales (a 1–5 item averaged with a 1–7 one), at the point where the
  score is created and again where it is read.
- **Note numbers in the Excel export are real numbers now.** Notes on documents,
  observation clips and dataset cells were all stored as `0`, so the export wrote
  `N-0` for every one of them while the workbench showed a sensible number. They
  are numbered per source now — and **gaps are correct**: deleting note 2 leaves
  1 and 3.
- **Quote positions in text containing emoji or rare CJK characters are repaired
  on first launch.** Where a quote sat in a segment containing such a character,
  the stored position drifted and the quote could resolve to the wrong words in
  exports and on the Canvas. This is corrected automatically the first time you
  open this version. Ordinary text was never affected, and nothing needs to be
  re-quoted by hand.
- **Some things look different.** Text boxes, dropdowns and outlined buttons now
  have a clearly visible border — they were nearly invisible against the page.
  Dimmed text on selected and now-playing rows is darker, several status and
  source colours were adjusted to meet contrast minimums, and a few error
  messages that were almost unreadable now aren't. Nothing moved; only contrast
  changed.

### Added

- **Text size control.** Settings → Appearance now has a text-size setting with
  **Ctrl/Cmd +**, **−** and **0** shortcuts, and the choice persists across
  restarts. The packaged desktop app previously had no way to enlarge text at
  all.
- **A split says what it left behind.** Splitting a segment carries its quotes
  onto the halves; where a quote had a note attached, the split now tells you how
  many notes stayed with the original rather than moving them silently.

### Changed

- **Qualitative charts can be embedded in a Canvas.** 1.3.0 shipped with this as
  a stated known limitation — code frequency, co-occurrence, saturation,
  comparisons, the summary table and the timeline could be saved as materials and
  then rendered as an empty "No data configured" box. All of them draw now, they
  export as images alongside the quantitative charts, and a material whose source
  has since been deleted says so instead of rendering blank. **That limitation is
  retired.**
- **The qualitative Sort control now moves the codes.** Choosing Alphabetical or
  Count with codes on the row axis left them in import order, and the Custom
  order — which you could author by dragging — never reached a chart at all. All
  four orders now apply to the code axis of the heatmap, bar and stacked bar, and
  a custom order travels with a chart saved to a Canvas.
- **Codes come before Notes** on every coding surface, consistently.
- **Declaring a missing value tells you what it did** to the column, rather than
  reporting only when it failed.

### Fixed

**Analysis and exports**

- The Descriptives summary table now takes every number from one source, so its
  counts, percentages and per-source columns follow your selection instead of
  mixing a selection-scoped count with a project-wide percentage.
- Its per-kind columns follow the selection too: an observations-only selection
  no longer reports "Conv. 1, Participants 11" for a selection containing
  neither.
- The comparison table explains a blank cell (too few usable values in a group)
  instead of leaving it empty.
- Every group-comparison export gets its own filename, so a second export no
  longer silently overwrites the first.
- Chart exports keep non-Latin characters in the filename — a wholly non-Latin
  chart name previously produced a file called `.png`.
- The Code-Conversation Matrix and the study CSV cover documents and observations
  as well as conversations.

**Coding, quotes and notes**

- A bulk code that partially fails is reported as a failure. Rows could
  previously be left painted as coded, with attribution, when nothing had been
  applied.
- A quote taken from a document carries its source on the Canvas and in every
  export; it previously had none.
- Dragging a quote onto a Canvas theme now produces the same embed as inserting
  it — the dragged version lost its text, its attribution and its clip link.
- Observation notes appear on the project-wide Memos & Notes page, and memos on
  documents and observations show a proper label and filter instead of a raw type
  name.
- Merging a colleague's project no longer disturbs quote positions that were
  already correct.

**Desktop app**

- A startup failure the app cannot recover from now shows what happened and what
  to do about it, instead of "the local engine exited unexpectedly" — including
  when the message contains a non-English path.
- Only one dialog appears when startup fails, and it is the one that names the
  cause.
- Canvas snapshot rotation no longer depends on which of two snapshots taken in
  the same second is judged older.

**Accessibility**

- The codebook tree, the source picker and the code picker are reachable and
  navigable by keyboard, and announce their structure and position instead of a
  flat list.
- The variable-group grid costs one tab stop with arrow-key movement inside it,
  rather than one tab stop per cell.
- A clip list tells a screen reader how many clips it has, rather than how many
  happen to be on screen.
- Colour swatches and menus on a code row no longer announce as unavailable while
  being fully operable.
- On a frozen observation, splitting and merging explain that the clip set is
  frozen instead of vanishing from the keyboard entirely.
- A code chip announces who applied it instead of reading out the badge initials.
- The app is usable at 200% zoom and at narrow window widths without the page
  scrolling sideways.
- Charts, tables, popovers and dialogs carry names; the skip link works; and the
  focus indicator and text colours meet contrast minimums across both themes.

## [1.3.0] - 2026-08-02

### Upgrade notes

Please read these before updating. Several of them change numbers you may
already have written down or reported.

- **SPSS `.sav` data imported before this release should be re-imported.**
  v1.2.0 correctly kept values SPSS had flagged as user-missing (for example
  "99 = Refused") out of your statistics — but it did so by discarding them
  outright rather than storing them as missing, so a refusal and a genuinely
  unanswered question became indistinguishable, and you could no longer count how
  many people declined to answer. This release stores them, marked as missing.
  **Data already imported cannot be repaired in place** — those cells were never
  written, so there is nothing to recover from. Re-import the `.sav` file to get
  the full record. Datasets imported from CSV or Excel are unaffected.
- **Coverage percentages will drop for recordings whose length was previously
  unknown.** `.mov` and `.webm` recordings never had their duration read, so
  coverage was measured against the end of your last clip rather than the end of
  the recording — which the coding itself defines, so it always read close to
  100%. The app now reads the true length on startup and coverage is measured
  against it. On one test project this moved a recording from 50.0% to 26.4%.
  Nothing about your coding changed; the denominator was wrong and now isn't.
- **Project-wide intercoder reliability changes if you have a frozen, coded
  observation.** Frozen clips now count toward the project's kappa and
  Krippendorff's alpha alongside conversations and documents. Reliability figures
  from v1.2.0 are not directly comparable — recompute before quoting them.
- **The study CSV export replaces one column with two.** `conversation_name`
  becomes `source_type` + `source_name`, because that file now includes document
  segments (silently missing since documents shipped) and observation clips
  alongside conversation turns. Every other column keeps its name, so a script
  reading `segment_id`, `text` or `code_3` still works — only the source column
  moves.
- **Dragging a code or a note onto a segment has been removed.** It worked, but
  it was mouse-only with no keyboard equivalent, screen readers announced it as
  meaningless ids, and in three of the four coding surfaces codes advertised
  themselves as draggable with nowhere to drop. Dragging a note also could not be
  undone. Every gesture it offered has a better equivalent, all unchanged: click
  a code in the rail, use its number/chord shortcut, or attach a note from the
  Notes panel (which is undoable, and has a keyboard path).
- **Code text is now pure black on light-coloured codes.** Three of the sixteen
  code colours previously rendered their label below the WCAG AA contrast
  minimum. Every code chip, node and clip bar is affected, so your codebook will
  look slightly different.

**Known limitation:** qualitative charts (code frequency, co-occurrence, and the
other qualitative material types) still cannot be embedded in a Canvas. They are
correctly labelled as such rather than silently rendering as something else, and
the full set is planned for a following release.

### Added

- **Observations — code a recording with no transcript.** A recording of an
  *event* rather than a conversation — a classroom, a clinic visit, a home visit,
  a usability session — is now a source in its own right, coded directly on its
  own timeline. Import a recording on its own and start from an empty timeline,
  cut it into fixed intervals for interval-style coding, or seed labelled clips
  from a `.vtt`/`.srt` cue file; the wizard shows the clip count, the first clips
  and any warnings before writing anything. Mark and adjust clips from the
  keyboard (**I/O** for in/out points, **J-K-L** transport with frame stepping,
  0.1 s boundary nudges, typed timecodes, split and merge by time), with a follow
  mode that keeps the view on the playhead. Clips carry codes, notes and
  time-range quotes, and reach search, the Canvas and the qualitative analysis
  surfaces like any other source.
- **Coverage for observations** — what share of the timeline you have marked,
  with a jump to the next unmarked gap.
- **Reliability for observations, both ways of cutting.** Leave the clip set
  **open** and each coder marks their own boundaries — agreement is then a
  unitizing problem, reported as Krippendorff's alpha at 100 ms resolution plus
  time-binned kappa, with the bin size shown as part of the result and per-code
  prevalence beside every kappa. **Freeze** the clip set once the team agrees the
  cuts and every coder codes the same clips, which brings the ordinary kappa,
  side-by-side reconciliation and the consensus layer to video unchanged.
- **Timed analytics per code** — duration, frequency, rate per minute, share of
  session airtime, bout length, and a stacked codeline of the whole session.
  Because clips can overlap, per-code airtimes don't sum to covered time, and the
  table says so.
- **Re-use a recording across source types.** "Also code this as an observation"
  (and the reverse) copies the file rather than re-uploading it, leaving the
  original source and all of its coding untouched.
- **Declared value labels for numbers-only columns.** A CSV whose cells are bare
  codes (`1`–`5`) can now be given a code-to-label dictionary — during import or
  afterwards — and the column behaves exactly as if it had arrived from SPSS with
  labels attached. Appending a code-format file to a labelled column maps it
  correctly.
- **Declared missing values.** Any column can declare which of its values mean
  "missing" — individual codes, or a numeric range such as `-99 THRU -1` —
  through a three-way choice in the column dictionary: use the built-in defaults,
  declare that nothing is missing, or list your own values. Every analysis,
  grouping, chart, data-quality check and R export honours the declaration
  consistently, so a "Prefer not to say" no longer counts as a real response
  anywhere. SPSS files bring their own declaration with them.
- **Observations appear across the app** — a card and stat on the project
  Overview, a fourth import path, a search filter, and inclusion in the
  qualitative analysis surfaces.

### Changed

- Code and note drag-and-drop was removed from the coding workbenches; see the
  upgrade notes above.
- Code label text now uses pure black or white for contrast, whichever the code's
  colour requires; see the upgrade notes above.
- The Excel study export spans all three source types and gains a **Quotes**
  sheet. On one real project this added 68 document rows that had never reached
  the workbook.
- REFI-QDA codebook exchange (`.qdc`) now uses the namespace the standard
  actually specifies. Files exported by earlier versions used a malformed
  namespace and would not open in other QDA software; import accepts both, so
  existing files still work.

### Fixed

- **Value labels could invert a reverse-scored column**, rewriting every response
  to its opposite. This is now refused rather than applied.
- **Reverse-scored recodes reflected around the wrong midpoint** when a column
  contained a missing code — a mapping like `{Never: 1, Always: 5, Prefer not to
  say: 99}` was reflected around 100, silently scoring "Never" as 99. Missing
  values no longer define the scale, and affected recodes repair themselves on
  startup.
- `.mov` and `.webm` recordings now have their duration read correctly; existing
  recordings are filled in on startup.
- Descriptives were unreachable in projects that contained only observations.
- The project Overview no longer describes an observation-only project as empty.
- A clip quote is no longer lost when its clip is split or merged.
- The Canvas Materials drawer no longer renders a clip quote as a blank, nameless
  row.
- Diagnostic logging was silently disabled in the packaged app, so failures that
  were caught and logged — a failed automatic backup, for instance — left no
  trace. Logging works again.
- `/analysis/integrated` reaches the Canvas again instead of redirecting to the
  project list.
- Merging a colleague's copy of a project now respects a frozen clip set from
  both directions: their clips can no longer be silently added to an observation
  you have frozen, and you are no longer told to "re-segment to match" when your
  own cuts are legitimately still open.
- Dependency updates clearing four advisories, including one in the shipped
  desktop tree.

## [1.2.0] - 2026-07-11

### Added

- **Video coding.** Conversations can now carry a video recording (`.mp4`,
  `.mov`, `.webm` — up to 4 GB) alongside or instead of audio. The video plays in
  a pane beside the transcript with the same timestamp synchronization as audio,
  so focus-group and observation footage can be coded without leaving the
  workbench. A recording — audio or video — can also be attached directly in the
  conversation-import wizard rather than afterwards. Automatic backup snapshots
  deliberately exclude video to stay small; downloaded backups include it by
  default, with an "Include video" option in Settings.
- **SPSS `.sav` dataset import.** Import and append `.sav` files anywhere you can
  import a CSV or Excel file. SPSS's own value labels, scale order, and
  user-missing codes come across, so an ordinal variable arrives with the order and
  the codes it was recorded with — a 0–3 scale stays 0–3 — instead of being guessed
  from the text. Values flagged as user-missing in SPSS (for example "Refused") are
  treated as missing rather than as an extra scale point.
- **Participant-ID columns now link your data automatically.** Columns like
  "Participant ID" or "Respondent" are recognized as identifier columns
  (previously they were discarded as import noise) and can link dataset rows to
  the project's participants — during import, when appending, or retroactively
  from the dataset view — so a person's survey record and their interview turns
  connect without hand-matching. Existing manual links are never overwritten, and
  ambiguous (duplicated) identifier values are left unlinked rather than guessed.
  The dataset view's per-row Link popover can also create a new participant from
  the row's ID in one step, and R exports carry identifier columns as plain
  character ID columns for joining external data (leading zeros preserved, no
  statistics computed on IDs).
- **Automatic updates.** The desktop app now keeps itself current: it checks
  quietly on launch and every few hours, downloads new versions in the
  background, and installs only when you choose "Restart to update" (or on your
  next quit) — never mid-work. Choosing "Restart to update" takes a fresh backup
  first. The check sends only the app's version and platform to github.com,
  nothing else, and can be switched off in Settings → Software update. This makes
  v1.2.0 the last release that has to be downloaded by hand.
- **Citation support.** A `CITATION.cff` file makes GitHub render a "Cite this
  repository" entry, and **Settings → About & citation** shows the running version
  with copyable APA and BibTeX references. Cite the version you analyzed with —
  it is part of what makes an analysis reproducible.
- The README now states support expectations (solo maintainer; Issues for bugs,
  Discussions for questions) and links the citation formats.

### Fixed

- Conversation import matches speaker names to participants after trimming
  stray spaces, so a trailing space in a CSV speaker label no longer silently
  creates a duplicate participant.
- Reverse-scored recodes now reflect a scale about its own midpoint. Scales
  numbered from 1 are unaffected; a scale numbered from 0 no longer reversed into
  values outside its own range.
- **SPSS import: partially-labelled scales import at full width.** SPSS files
  routinely label only a scale's endpoints (1 = "Not at all" … 7 = "Extremely");
  those scales previously imported as two-point scales and quietly dropped every
  mid-scale answer. Unlabelled in-range codes now become scale points, codes
  outside the scale surface as a warning instead of vanishing silently, and a
  label span too wide to be a scale (1 = "Low" / 100 = "High") imports as plain
  numbers.
- **R export converts ordinal and binary factors back to their real codes.**
  Exported scripts previously used R's positional factor coding, which shifted
  means for 0-based scales, diverged correlations for gapped code sets, and could
  error outright on statistical tests over ordinal columns.
- Appending rows to a reverse-scored column re-applies the reverse scoring to the
  new rows (they previously landed forward-coded next to reversed neighbors).
- The SPSS row-count cap now binds while reading the file, so a file whose header
  under-reports its size can no longer exhaust memory.
- Dropping an `.xlsx` or `.sav` file onto the Datasets page now opens the import
  wizard (previously only `.csv` was accepted there).
- The BibTeX citation renders on screen in Settings, so it remains reachable when
  the browser clipboard is unavailable (plain-http deployments).
- **Leaving the import wizard while a recording is still attaching is now safe.**
  A recording that finishes attaching after you navigate elsewhere announces
  itself with a notification instead of yanking you into the workbench — and a
  failed attach shows a notification instead of failing silently (previously the
  conversation simply had no recording, with no message at all). Import warnings
  also now survive the recording-failed path: they appear on the failure card and
  after a successful retry.
- The conversations list shows a just-attached recording immediately, instead of
  serving a cached "no recording" state for up to a minute.
- Uploads that fill the disk now report "not enough disk space" reliably — the
  earlier phase of the upload pipeline previously reported a generic server error.
- Very large recording uploads on a slow connection no longer time out just short
  of completion (the timeout ceiling now covers a maximum-size file at the
  slowest assumed transfer rate).
- **SPSS import: two codes sharing one value label stay distinguishable.** Each
  duplicated label is suffixed with its code ("Agree (1)" / "Agree (2)") instead
  of the two answers silently collapsing onto one number.
- SPSS import: values declared missing on *text* variables (for example "XX" or
  "SKIP") now import as missing instead of as answers.
- Reverse-scored recodes with a non-numeric entry in the mapping (for example a
  "not scored" label) now reverse the numeric values consistently everywhere —
  previously a single such entry could leave individually edited cells
  un-reversed while bulk-applied cells were reversed.
- Editing a scale's recode mapping now also updates the column's stored scale
  metadata, so exports and appends that fall back to it can't see pre-edit codes.
- Creating a category-grouping recode as a column's first recode now clears the
  column's numeric encoding, matching what editing one already did.

## [1.1.1] - 2026-07-03

### Fixed

- The "Add coder" entry point now appears in Settings (Coder identity) and in
  the projects-screen coder menu, including on single-coder installs.
  Previously the only place to add a coder was a menu that exists only inside
  an open project, which left the team-coding features hard to discover.

## [1.1.0] - 2026-07-03

### Added

**Team coding.** A project can now be coded independently by several
researchers and brought back together.

- Coder identities: a coder roster with quick switching, per-coder attribution
  badges on every coding, a per-coder visibility filter, and coder archiving.
- Blind coding: on multi-coder projects, colleagues' codings are hidden by
  default while you code; revealing them is a deliberate, logged action.
- A derived consensus layer (majority agreement across coders) that recomputes
  automatically as coding changes, with a coding-layer selector (your coding
  vs. consensus) on the analysis and codebook surfaces.
- A reconciliation view showing each coder's codes side by side per segment,
  with disagreements flagged — reconcile by editing your own layer inline.
- Inter-rater reliability: Cohen's kappa (two coders), Krippendorff's alpha
  (more), and percent agreement — validated to match R's `irr` package
  exactly, and emitted into the R script export.
- Project merge for distributed coding: share a copy of a project with
  co-coders ("copy for coding"), then merge their coded copies back. Merging
  matches shared sources by stable identity, asks you to confirm how coders in
  the file map to coders on your machine, and walks you through reconciling
  codebooks that diverged while apart.
- A codebook freeze (soft lock) for distributing a stable codebook to
  co-coders.

**New import formats.**

- Excel workbooks (`.xlsx`) import directly as datasets, with a sheet picker
  and append support. Formula cells import their last-calculated values;
  legacy `.xls` and SPSS `.sav` files are not supported.
- Zoom and Microsoft Teams transcripts (`.vtt`/`.srt`) import directly as
  conversations — consecutive captions from the same speaker merge into turns,
  and cue timestamps carry over for audio sync.

**Analysis and navigation.**

- A codebook Overview treemap showing each code's share of coding at a glance
  (replaces the force-directed Network view).
- Duplicate project from the dashboard, and the projects list now orders by
  real last activity.
- In-vivo coding: creating a code while text is selected prefills the code
  name with the selected text.
- Text-coding "randomize order" now actually shuffles and takes an optional
  seed for reproducible review passes.
- Dataset import discloses which values (N/A, "Don't know", refusals) will be
  treated as missing.
- R export gained additional ggplot2 chart types alongside the new
  inter-rater reliability block.

### Changed

- The coding workbenches are fully keyboard- and screen-reader-navigable (the
  virtualized transcript, document, and text lists expose proper listbox/grid
  semantics with focus management).
- Consistent terminology: open-ended dataset responses are called "text"
  throughout (previously a mix of "comment" and "text"), and analysis surfaces
  scoped by blind mode now label that scope explicitly.
- Visual consistency pass: one shared style for selected/active states across
  the app, larger click targets for color swatches, and workbench toolbars
  that wrap instead of clipping controls on small windows.

### Fixed

- A full numbers audit of displayed statistics, charts, and exports against an
  independent oracle (and real R): corrected bar-chart label alignment when
  zero-count groups are hidden, group counts shown next to comparisons,
  text-analysis denominators that could disagree with the coding-progress
  gauge, code-usage counts on multi-coder projects, and a negative chi-square
  edge case in the missing-data (MCAR) test. Exported `.mmproject` files and
  R scripts reproduce the app's numbers faithfully.
- Merging codes or categories no longer risks losing codings that were being
  reassigned in the same operation.
- Document notes now appear on the Memos & Notes page.
- Assorted smaller fixes: clearer error messages, recode tooltips, source
  filter labels, and copy corrections.

## [1.0.1] - 2026-06-20

### Fixed
- Windows installer is now re-signed with an RFC-3161 timestamp so the
  Authenticode signature stays valid after the short-lived signing certificate
  rotates. The v1.0.0 Windows installer began showing "Unknown publisher" once
  its certificate expired; this release restores the verified-publisher
  signature. macOS (Apple Silicon) and Linux downloads are unchanged.

## [1.0.0] - 2026-06-19

First public release. Signed installers for Windows and macOS (Apple Silicon),
plus a Linux AppImage, are attached to the release on the
[Releases page](https://github.com/gfchavez28/mixedmeasures/releases).

### Added
- Local-first desktop workspace for mixed-methods research: import datasets (CSV),
  documents (`.docx`, `.pdf`, `.txt`), and conversation transcripts (CSV, with
  optional synchronized audio).
- Three keyboard-driven qualitative coding surfaces (conversations, documents,
  open-ended text columns) over a shared codebook, excerpts, memos, and notes.
- Quantitative analysis: descriptives, group comparisons (t-test, ANOVA,
  Kruskal–Wallis, Mann–Whitney), correlation, cross-tabulation, reliability, and
  scale/domain aggregation.
- A shared participant/speaker identity spine linking survey records to interview
  speakers across sources.
- An integration **Canvas** for writing findings with live excerpts, memos, and
  analysis results embedded inline.
- Project portability (`.mmproject`), codebook exchange, R script export, and
  multi-format data export.
- At-rest database encryption (SQLCipher) and a layered backup system in packaged
  desktop builds.

[Unreleased]: https://github.com/gfchavez28/mixedmeasures/compare/v1.5.2...HEAD
[1.5.2]: https://github.com/gfchavez28/mixedmeasures/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/gfchavez28/mixedmeasures/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gfchavez28/mixedmeasures/releases/tag/v1.0.0
