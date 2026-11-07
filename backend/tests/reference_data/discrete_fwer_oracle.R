# The discrete Holm ORACLE for the code-by-group comparison (#1323, D1 of the 1.5.9
# pre-implementation review, 2026-10-31).
#
# WHAT IT WRITES: `discrete_fwer_oracle.json` beside this file — families of
# code-by-group presence tests (users / non-users per group), and for each family
# what R computes for it:
#   * every test's two-sided exact p ("minlike": the mass of every table no more
#     probable than the observed one — R's fisher.test rule);
#   * every test's SUPPORT, the p-values a table with those margins can produce;
#   * the adjusted p-values of discrete Holm (DiscreteFWER::DHolm — Zhu & Guo 2019,
#     step-down, family-wise error under arbitrary dependence; on prepared input and
#     capped at 1, because the package has two arithmetic defects — see the ⚠️ block
#     below `family_record`), plain Holm and Benjamini-Hochberg (stats::p.adjust);
#   * the same three corrections applied to the vector of every test's SMALLEST
#     attainable p — the "can't reach significance" marker's definition (D2).
# `backend/tests/test_discrete_fwer_oracle.py` checks `services/comparison_basis.py`
# and `services/multiplicity.py` against it.
#
# WHY A FROZEN FILE, NOT A LIVE R TEST: DiscreteFWER compiles C++ (Rcpp, RcppArmadillo)
# and needs Rcpp >= 1.0.13 while Ubuntu noble packages 1.0.12, so installing it in CI
# would be a source build of several CRAN packages on every backend run. The values
# do not change between runs, so they are computed once, here, and committed
# (decided 2026-10-31b with the developer). CI never runs this script.
#
# WHY IT IS STILL AN ORACLE: nothing here reads Mixed Measures code or output. The
# families are built in this file, two-group p-values and supports come from
# DiscreteTests::fisher_test_pv, and three-or-more-group supports by listing every
# table with the observed margins and asking stats::fisher.test for each one's p.
#
# TO REGENERATE (needs the packages in a local R library):
#   install.packages("DiscreteFWER")   # also installs DiscreteFDR, DiscreteTests, DiscreteDatasets
#   cd backend/tests/reference_data && Rscript --vanilla discrete_fwer_oracle.R
# A regeneration that changes any number is a finding about the package or this
# script — read the diff before committing it.

suppressPackageStartupMessages({
  library(DiscreteFWER)
  library(DiscreteTests)
  library(jsonlite)
})

ALPHA <- 0.05

# p-values from different tables with the same probability are equal in exact
# arithmetic and differ by rounding here; one tolerance merges them.
dedupe <- function(p) {
  p <- sort(p)
  keep <- c(TRUE, diff(p) > 1e-12 * pmax(p[-1], 1e-300))
  out <- p[keep]
  # DiscreteFWER requires each support to end at exactly 1; the most probable
  # table's p is 1 up to rounding.
  if (abs(out[length(out)] - 1) < 1e-12) out[length(out)] <- 1
  out
}

# Two groups: one row per code, through DiscreteTests.
two_group_tests <- function(successes, sizes) {
  a <- sapply(successes, `[`, 1)
  c <- sapply(successes, `[`, 2)
  df <- data.frame(X1 = a, Y1 = sizes[1] - a, X2 = c, Y2 = sizes[2] - c)
  tr <- fisher_test_pv(df, ts_method = "minlike")
  list(p = unname(tr$get_pvalues()),
       supports = lapply(tr$get_pvalue_supports(), function(s) dedupe(unname(s))))
}

# Three or more groups: every k x 2 table with the observed group sizes and the
# observed total of users, each one's p from stats::fisher.test (exact here: the
# tables are small), and the observed table's p the same way.
kx2_test <- function(x, sizes) {
  total <- sum(x)
  grid <- expand.grid(lapply(sizes, function(n) 0:n))
  grid <- grid[rowSums(grid) == total, , drop = FALSE]
  fp <- function(v) fisher.test(cbind(v, sizes - v))$p.value
  ps <- apply(grid, 1, function(v) fp(as.numeric(v)))
  list(p = fp(x), support = dedupe(ps))
}

kx2_tests <- function(successes, sizes) {
  res <- lapply(successes, kx2_test, sizes = sizes)
  list(p = sapply(res, `[[`, "p"), supports = lapply(res, `[[`, "support"))
}

family_record <- function(name, sizes, successes) {
  stopifnot(length(sizes) >= 2)
  for (x in successes) {
    stopifnot(length(x) == length(sizes), all(x >= 0), all(x <= sizes))
    # A code nobody, or everybody, used has no test and is not in the family
    # (comparison_basis.presence_test returns None for it).
    stopifnot(sum(x) > 0, sum(x) < sum(sizes))
  }
  t <- if (length(sizes) == 2) two_group_tests(successes, sizes) else kx2_tests(successes, sizes)
  raw <- t
  t <- canonicalise(t)
  mins <- sapply(t$supports, `[`, 1)
  rec <- list(
    name = unbox(name),
    sizes = sizes,
    successes = successes,
    raw_p = t$p,
    supports = t$supports,
    discrete_holm = dholm(t$p, t$supports),
    holm = p.adjust(t$p, "holm"),
    bh = p.adjust(t$p, "BH"),
    best_case = list(
      discrete_holm = dholm(mins, t$supports),
      holm = p.adjust(mins, "holm"),
      bh = p.adjust(mins, "BH")
    )
  )
  # The evidence for the two corrections below, kept visible: what DHolm returns on
  # the unprepared input.
  raw_mins <- sapply(raw$supports, `[`, 1)
  as_is <- suppressWarnings(c(DHolm(raw$p, raw$supports)$Adjusted, DHolm(raw_mins, raw$supports)$Adjusted))
  rec_attr <- c(rec$discrete_holm, rec$best_case$discrete_holm)
  attr(rec, "as_is_differs") <- any(abs(as_is - rec_attr) > 1e-12 * pmax(rec_attr, 1e-300))
  rec
}

# ⚠️ TWO NUMERICAL DEFECTS IN DiscreteFWER 1.0.0, found 2026-10-31b when this oracle
# first disagreed with the app in 6 of 17 families. Neither is a difference of METHOD
# (Zhu & Guo's step-down is what `kernel_DFWER_stepwise_fast` computes); both are
# arithmetic, and each is corrected here rather than inherited:
#
#  1. EXACT COMPARISON. The kernel evaluates F_j(t) — the largest attainable p of test
#     j that is <= t — with an exact `<=`. Two tables of different tests can have the
#     same p in exact arithmetic and differ in the last bit in floating point
#     (2.5695242602917774e-08 vs ...781e-08), and when test j's copy lands a hair
#     ABOVE t, F_j(t) drops a whole step: the sum comes out too SMALL, i.e. the
#     package errs toward significance. An emulation of the kernel with an exact
#     comparison reproduced DHolm in every family checked; with a tolerance it did not.
#     Remedy: `canonicalise` gives every mathematically equal value in a family ONE
#     double, so the package's exact comparison is the mathematical one.
#  2. NO CAP AT THE FIRST STEP. The kernel caps steps 2..m at 1 and never step 1, so
#     a first sum of 1.6 comes back as an adjusted p of 1.6 and the running maximum
#     carries it to every later code. An adjusted p above 1 is meaningless, and the
#     package's own cap on every other step says 1 is intended. Remedy: `dholm` caps.

canonicalise <- function(t) {
  pool <- sort(unique(c(unlist(t$supports), t$p)))
  starts <- c(TRUE, diff(pool) > 1e-12 * pool[-1])
  cluster <- cumsum(starts)
  # The cluster's largest member represents it, so a value of 1 stays exactly 1
  # (DiscreteFWER requires each support to end at 1).
  rep_of <- tapply(pool, cluster, max)
  snap <- function(v) {
    i <- findInterval(v, pool)
    i[i == 0] <- 1
    # findInterval lands on the largest pool member <= v; v is in the pool up to
    # rounding, so check the nearest of that member and the next one.
    j <- ifelse(i < length(pool) & abs(pool[pmin(i + 1, length(pool))] - v) < abs(pool[i] - v), i + 1, i)
    stopifnot(all(abs(pool[j] - v) <= 1e-12 * pmax(v, 1e-300)))
    unname(rep_of[cluster[j]])
  }
  supports <- lapply(t$supports, function(s) unique(snap(s)))
  p <- snap(t$p)
  # Every observed p must now be EXACTLY a point of its own support.
  stopifnot(all(mapply(function(x, s) x %in% s, p, supports)))
  list(p = p, supports = supports)
}

dholm <- function(p, supports) pmin(1, DHolm(p, supports)$Adjusted)

rep_codes <- function(spec) {
  # spec: list of c(successes..., count)
  out <- list()
  for (s in spec) {
    k <- length(s)
    for (i in seq_len(s[k])) out[[length(out) + 1]] <- s[-k]
  }
  out
}

families <- list()
add <- function(rec) families[[length(families) + 1]] <<- rec

# 1. The review's 6 v 6 fixture, 40 codes (the record's "lead's re-check"): plain
#    Holm stars nothing, discrete Holm stars three, and the marker counts 20.
add(family_record("review_6v6_40_codes", c(6, 6), rep_codes(list(
  c(6, 0, 3), c(5, 0, 3), c(5, 1, 4), c(3, 3, 10), c(1, 0, 10), c(2, 0, 10)
))))

# 2. Session A's four_codes fixture at 8 v 8 (X, Y, Z of test_comparison_unit_1323).
add(family_record("four_codes_8v8", c(8, 8), list(c(8, 0), c(6, 1), c(4, 4))))

# 3. The marker's discriminating family: ranked first, the five-user code's Holm
#    threshold is 4 x .0152; with the three six-user codes rejected ahead of it,
#    it is 1 x .0152.
add(family_record("discriminating_6v6", c(6, 6), list(c(6, 0), c(6, 0), c(6, 0), c(5, 0))))

# 4. Seeded random two-group families: unequal sizes, heterogeneous prevalence,
#    about a third of the codes with a real difference.
set.seed(1323)
draw_codes <- function(sizes, m) {
  out <- list()
  while (length(out) < m) {
    base <- rbeta(1, 0.8, 1.2)
    lift <- if (runif(1) < 0.35) runif(1, 0.2, 0.6) else 0
    probs <- c(min(1, base + lift), rep(base, length(sizes) - 1))
    x <- rbinom(length(sizes), sizes, probs)
    if (sum(x) == 0 || sum(x) == sum(sizes)) next
    out[[length(out) + 1]] <- x
  }
  out
}
two_group_plan <- list(
  list(c(3, 3), 6), list(c(4, 5), 8), list(c(5, 5), 10), list(c(6, 6), 12),
  list(c(7, 4), 15), list(c(8, 8), 20), list(c(10, 6), 25), list(c(12, 12), 30),
  list(c(15, 9), 40), list(c(20, 20), 12)
)
for (plan in two_group_plan) {
  sizes <- plan[[1]]
  add(family_record(sprintf("random_%dv%d_%d_codes", sizes[1], sizes[2], plan[[2]]),
                    sizes, draw_codes(sizes, plan[[2]])))
}

# 5. Seeded random families of three and four groups (Freeman-Halton).
kx2_plan <- list(list(c(3, 4, 5), 8), list(c(5, 5, 5), 10), list(c(6, 3, 4), 6),
                 list(c(3, 3, 4, 2), 7))
for (plan in kx2_plan) {
  sizes <- plan[[1]]
  add(family_record(sprintf("random_%s_%d_codes", paste(sizes, collapse = "v"), plan[[2]]),
                    sizes, draw_codes(sizes, plan[[2]])))
}

meta <- list(
  generator = "backend/tests/reference_data/discrete_fwer_oracle.R",
  r_version = R.version.string,
  packages = list(
    DiscreteFWER = as.character(packageVersion("DiscreteFWER")),
    DiscreteTests = as.character(packageVersion("DiscreteTests"))
  ),
  alpha = ALPHA,
  seed = 1323
)

as_is_differs <- vapply(families, function(f) isTRUE(attr(f, "as_is_differs")), TRUE)
families <- lapply(families, function(f) { attr(f, "as_is_differs") <- NULL; f })

# One family per line, so a regeneration diffs family by family. No auto_unbox: a
# code only one person used has the one-value support {1}, which must stay a list.
lines <- vapply(families, function(f) as.character(toJSON(f, digits = NA)), "")
out <- c("{",
         paste0('"meta": ', toJSON(meta, auto_unbox = TRUE), ","),
         '"families": [',
         paste0(lines, c(rep(",", length(lines) - 1), "")),
         "]}")
writeLines(out, "discrete_fwer_oracle.json")
cat(sprintf("wrote %d families, %d tests\n", length(families),
            sum(sapply(families, function(f) length(f$raw_p)))))
cat(sprintf("DHolm on the unprepared input differs in %d of %d families: %s\n",
            sum(as_is_differs), length(families),
            paste(vapply(families[as_is_differs], function(f) as.character(f$name), ""), collapse = ", ")))
