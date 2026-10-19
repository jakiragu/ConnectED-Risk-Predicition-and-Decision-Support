<!--
Synthetic academic-risk dataset methodology.
This document describes the generator design and its assumptions; it does not
claim that the synthetic data represent Kenyan students.
-->

# Data Synthesis Methodology

## 1. Prediction Framework and Final Outcome

The synthetic dataset represents three academic terms, with two assessments per term:

- Term 1 Midterm (T1M)
- Term 1 Final (T1F)
- Term 2 Midterm (T2M)
- Term 2 Final (T2F)
- Term 3 Midterm (T3M)
- Term 3 Final (T3F)

There are five prediction points: T1M, T1F, T2M, T2F, and T3M. At each prediction point, only information available up to that point is permitted as model input. T3F is never used as a predictor.

The final outcome is based on the student’s average performance across the nine simulated academic domains at T3F:

\[\mathrm{FinalAverage}_i=\frac{1}{S}\sum_{s=1}^{S}G_{i,s,T3F},\quad S=9\]

where \(S=9\) is the number of simulated academic domains.

A student is classified as academically at risk when:

\[\mathrm{At\_Risk}_i=\begin{cases}1,&\mathrm{FinalAverage}_i<P\\0,&\mathrm{FinalAverage}_i\ge P\end{cases}\]

where \(P\) is the institutionally defined passing threshold. The current simulation uses \(P=50\).

The T3F scores therefore establish the target but are excluded from every prediction snapshot.

## 2. Purpose and Design of the Synthetic Dataset

The dataset is intended to provide an empirically informed but synthetic longitudinal benchmark for:

1. academic-risk prediction;
2. comparison of Logistic Regression, Random Forest, and XGBoost;
3. global and local SHAP explanations;
4. DiCE counterfactual explanations; and
5. evaluation of whether explanations recover the mechanisms intentionally embedded in the generator.

The dataset is **not intended to statistically reproduce Kenyan students or the Kenyan education system**. The empirical datasets are used to constrain and inform aspects of the simulation, while parameters that cannot be directly estimated are explicitly treated as modelling assumptions.

This distinction is important because neither source dataset provides a complete longitudinal representation of the intended Kenyan academic setting.

The final simulation contains 5,000 students, nine academic domains, and six assessment periods.

## 3. Empirical Calibration Sources

### 3.1 Halabja Student Grade Dataset

The Halabja Student Grade Dataset contains approximately 16,824 records and 20 attributes and provides academic scores on a 0–100 scale. It was selected primarily because its grade scale is directly compatible with the intended synthetic score scale and because it contains performance information across multiple academic subjects. 

The dataset is used for:

- subject-level performance distributions;
- approximate subject means and standard deviations;
- examination of cross-subject dependence;
- assessment of the relative strength of common academic performance across subjects. 

It is used as a **calibration reference rather than as a representation of Kenyan students**. Consequently, the statistics derived from Halabja are treated as plausible empirical reference values rather than estimates of the corresponding characteristics of the target population. 

The empirical subject references used in the simulation are:

| Subject             | Mean | SD   |
| ------------------- | ---- | ---- |
| Mathematics         | 56.4 | 19.7 |
| English             | 58.7 | 20.1 |
| Kiswahili           | 61.0 | 17.9 |
| Chemistry           | 55.8 | 18.5 |
| Biology             | 55.5 | 18.5 |
| Physics             | 53.9 | 17.5 |
| History             | 53.0 | 15.6 |
| Geography           | 52.1 | 15.1 |
| Religious Education | 73.7 | 15.9 |

Kiswahili was derived using the documented proxy procedure described in the **Problems Encountered and Implementation Refinements** section.

### Why Halabja was used

The cross-subject correlations are used to inform the **relative strength of common academic performance** across the synthetic subjects. They are not treated as direct estimates of latent factor loadings. The resulting factor-loading values are therefore simulation calibration parameters derived from the observed relative association structure rather than formal factor-analysis estimates.

The source is consequently used to establish plausible marginal distributions and general cross-subject dependence, not to claim that its students or statistics represent the target population.

### 3.2 UCI Student Performance Dataset

The UCI Student Performance dataset provides longitudinal academic information through the G1, G2, and G3 grades and therefore provides useful evidence about persistence between successive academic outcomes.

The Math dataset contains 395 students and the Portuguese dataset contains 649 students. The grade variables are measured on a 0–20 scale.

The observed descriptive statistics are:

| Dataset     | Grade | Mean  | SD   |
| ----------- | ----- | ----- | ---- |
| Mathematics | G1    | 10.91 | 3.32 |
| Mathematics | G2    | 10.71 | 3.76 |
| Mathematics | G3    | 10.42 | 4.58 |
| Portuguese  | G1    | 11.40 | 2.75 |
| Portuguese  | G2    | 11.57 | 2.91 |
| Portuguese  | G3    | 11.91 | 3.23 |

The UCI data indicate strong positive persistence between successive assessments. The observed relationships used to inform the simulation include approximately:

- G1 → G2: 0.85 in Mathematics and 0.87 in Portuguese;
- G2 → G3: approximately 0.91 in Mathematics and 0.92 in Portuguese;
- G1 → G3: approximately 0.80 in Mathematics and 0.83 in Portuguese.

These relationships provide empirical support for incorporating previous academic performance as an important component of subsequent performance. They do **not**, however, establish a universal persistence coefficient or directly estimate the persistence process for the synthetic population.

The simulation therefore adopts:

\[\beta=0.85\]

as a central **simulation calibration parameter**, selected to represent strong persistence between successive academic outcomes and informed by the observed UCI relationships. The value is not claimed to be an empirical estimate of Kenyan student progression.

Furthermore, the UCI datasets contain **three grade stages (G1, G2, and G3)** rather than the six assessment periods used in the synthetic dataset. Extending the persistence mechanism across six synthetic assessment periods is therefore a **modelling assumption informed by the observed UCI persistence**, rather than a direct replication of the UCI structure.

This distinction ensures that the UCI data are used to justify the inclusion and approximate strength of longitudinal persistence without presenting the UCI coefficient as an empirically estimated parameter for the complete six-assessment synthetic process.

## 4. Subject Structure and Cross-Subject Dependence

The simulation contains nine academic domains:

1. Mathematics
2. English
3. Kiswahili
4. Chemistry
5. Biology
6. Physics
7. History
8. Geography
9. Religious Education

The simulation does not model Kenyan school tracks or assume a particular set of compulsory subjects. The nine domains are treated as modelling domains used to construct a common synthetic academic-performance benchmark.

### Factor loadings

A persistent student-level academic ability factor is used to induce dependence between subjects.

The factor loadings are:

| Subject             | Loading |
| ------------------- | ------- |
| Mathematics         | 0.72    |
| English             | 0.69    |
| Kiswahili           | 0.87    |
| Chemistry           | 0.81    |
| Biology             | 0.81    |
| Physics             | 0.79    |
| History             | 0.68    |
| Geography           | 0.70    |
| Religious Education | 0.69    |

These values are **simulation calibration parameters**, not formal factor-analysis estimates. The Halabja data show positive relationships between the observed subjects, with correlations ranging approximately from 0.44 to 0.87. These relationships were used to establish the relative strength of cross-subject academic association and, consequently, the intended ordering of the synthetic common-factor loadings. 

The loading values were not obtained by directly treating pairwise correlations as factor loadings. A pairwise correlation describes the observed association between two subjects, whereas a factor loading represents the relationship between an individual subject and a latent factor. The Halabja correlations were therefore used as empirical evidence for the **relative ordering and magnitude range** of the loadings rather than as direct loading estimates. The Kiswahili value is, again,  a **proxy-informed simulation parameter**, rather than an empirical estimate of Kiswahili's latent academic association. 

The resulting synthetic cross-subject correlation matrix is subsequently evaluated against the **general structure and relative strength of relationships** observed in Halabja. The purpose of this validation is to determine whether the synthetic subjects exhibit a plausible pattern of positive cross-subject dependence, rather than to reproduce individual empirical correlations exactly. 

## 5. Persistent Student Ability

Each student receives a latent academic ability:

\[A_i\sim\mathcal{N}(0,1)\]

This variable represents persistent differences between students in general academic performance.

For subject s, the ability contribution is:

\[\mathrm{AbilityEffect}_{i,s}=\sigma_s\lambda_s A_i\]

where:

- s is the subject-specific factor loading;
- s is the target subject standard deviation; and
- Ai is the student’s latent academic ability.

The multiplication by s scales the ability contribution to the subject's score distribution, while s controls the relative strength of the relationship between general academic ability and performance in that subject.

The initial latent score combines the subject mean, the persistent ability contribution, and an independent residual component. The residual variance is defined so that the initial unbounded latent score has the intended target variance, provided the ability and residual components are independent.

The factor loadings are calibration parameters informed by the relative cross-subject association structure observed in the Halabja Student Grade Dataset. They are not formal factor-analysis estimates, and the resulting synthetic relationships are assessed through cross-subject validation.

Validation examines the relationship between latent ability and generated performance at T1M to confirm that the intended ability structure is reflected in the generated data. Because observed scores undergo a bounded transformation, the realised correlations between ability and observed scores are not expected to reproduce the factor loadings exactly.

## 6. Latent and Observed Academic Scores

A major implementation refinement was the separation of **latent academic scores** from **observed academic scores**.

This distinction was introduced because directly feeding bounded observed scores back into the longitudinal recursion would cause the 0–100 boundaries to influence future latent performance and could distort the intended persistence mechanism.

The simulation therefore maintains:

- Gi,s,t\*: latent score;
- Gi,s,t: observed 0–100 score.

The latent score is used for the longitudinal recursion, while the observed score is generated from the latent score after the relevant mechanisms have been applied.

## 7. Initial Assessment Generation

At T1M there is no previous assessment.

The latent score is therefore:

\[G^*_{i,s,T1M}=\mu_s+\sigma_s\lambda_s A_i+\epsilon_{i,s,T1M}\]

where:

\[\epsilon_{i,s,T1M}\sim\mathcal{N}(0,\sigma_{\epsilon,s}^{2})\]

and the residual standard deviation is defined as:

\[\sigma_{\epsilon,s}=\sigma_s\sqrt{1-\lambda_s^2}\]

This construction ensures that the ability component and residual component jointly reproduce the intended variance at the initial stage.

T1M deliberately contains no previous-performance, attendance, failure-history, or interaction effect because no earlier assessment is available.

## 8. Longitudinal Academic Performance

From T1F onward, the latent score follows a longitudinal recursion:

\[G^*_{i,s,t}=\mu_s+\sigma_s\lambda_s A_i+\beta\left(G^*_{i,s,t-1}-\mu_s-\sigma_s\lambda_s A_i\right)+E^{attendance}_{i,t}+E^{failure}_{i,t}+E^{interaction}_{i,s,t}+\epsilon_{i,s,t}\]



This formulation separates:

- persistent student ability;
- persistence from previous performance;
- attendance;
- cumulative failure history;
- the controlled attendance-performance interaction; and
- random residual variation.

The persistence term applies  to the previous latent score's deviation from the student's ability-based baseline. This allows previous performance to influence subsequent performance while retaining a persistent student-level ability contribution.

The value (=0.85) is an empirically informed simulation parameter selected in light of the strong successive-grade relationships observed in the UCI Student Performance Dataset. It is not an estimate of persistence among Kenyan students or a guarantee that successive observed assessment scores will have a correlation of 0.85.

The realised longitudinal correlations depend on the combined effects of persistence, attendance, historical failures, the interaction, residual variation, and the transformation to bounded observed scores.

The recursion begins at T1F because T1M has no preceding assessment. At T1M, the latent score is generated using the subject mean, ability contribution, and initial residual component only. Attendance, failure history, previous performance, and their interaction are not applied at this initial assessment.

The previous latent score, rather than the bounded observed score, is used in the recursion. This prevents the 0–100 boundaries applied to observed scores from being directly propagated through subsequent latent performance.

After the latent score has been generated, it is transformed into an observed score bounded between 0 and 100. The latent and observed scores are retained separately to support longitudinal generation and validation.

## 9. Attendance Generation

Attendance is generated as a longitudinal process rather than as independent values at each assessment.

The latent attendance process is represented as:

\[Attendance^*_{i,t}=R_i+s_i(t-1)+P_t+\epsilon^{attendance}_{i,t}\]

where:

- Ri is the student’s baseline attendance component;
- si is the student’s attendance trajectory slope;
- Pt is the assessment-period component; and
- i,tattendance is attendance-specific random variation.

Three generator-internal trajectory categories are used:

- Stable: 60%;
- Improving: 20%;
- Declining: 20%.

The initial configuration used a stronger improving slope. This produced excessive concentration of improving students near the 100% boundary in later periods. The improving slope was therefore reduced to **+1.5 percentage points per period**, while the declining slope remained **−3 points per period**.

The current attendance configuration is:

| Parameter            | Value |
| -------------------- | ----- |
| Baseline mean        | 90    |
| Baseline SD          | 7     |
| Attendance noise SD  | 2     |
| Stable slope mean    | 0     |
| Improving slope mean | +1.5  |
| Declining slope mean | −3    |
| Slope SD             | 0.8   |

The change to the improving slope illustrates an important principle in the generator: an assumption should not be retained merely because it is initially plausible if validation demonstrates that it produces undesirable artificial boundary behaviour.

### Attendance reference

The attendance effect is centred around a single reference value:

\[E^{attendance}_{i,t}=\alpha(Attendance_{i,t}-Attendance_{reference})\]

The reference is calculated from the generated population rather than hard-coded as 90.

It is calculated once and then held fixed across all periods.

This prevents the centre of the attendance effect from changing as the simulated population progresses through time.

The central attendance-effect parameter is:

\[\alpha=0.25\]

which corresponds approximately to a 2.5-point score difference for a 10-percentage-point attendance difference from the reference.

Sensitivity configurations use:

{0.15,0.25,0.35}

The central attendance-effect parameter, α=0.25, is an empirically informed simulation parameter. Dräger, Klein and Sosu (2025) reported that a 10-percentage-point increase in absences was associated with reductions of approximately 0.08–0.19 standard deviations in overall attainment, with comparable negative associations for mathematics and English. When expressed in the synthetic dataset's raw score scale, a value of α=0.25 corresponds to a 2.5-point difference for a 10-percentage-point attendance difference, or approximately 0.12–0.17 standard deviations across the subject SDs used in the generator. This falls within the range reported by Dräger et al. (2025), providing empirical support for the magnitude of the selected parameter. The parameter remains a simulation calibration value rather than a direct estimate for the synthetic target population. 

### Attendance implementation correction

During implementation, the attendance noise standard deviation was initially not being consistently applied inside the truncated-normal generation process. The relevant probability transformation was corrected so that the configured attendance_noise_sd is used rather than an unintended hard-coded value.

Attendance validation now examines:

- overall distributions;
- trajectory-specific means and SDs;
- longitudinal correlations;
- exact 0/100 boundaries;
- near-boundary values; and
- attendance-performance relationships.

The trajectory labels, baseline, slope, and latent attendance are retained as **generator audit variables only** and are not intended as model predictors.

## 10. Cumulative Historical Failure

Historical failures are derived from the student’s average performance across all nine academic subjects at each completed assessment. The assessment average is calculated as:

\[\bar{G}_{i,t}=\frac{1}{9}\sum_{s=1}^{9}G_{i,s,t}\]

An assessment is classified as a failure when the student’s average is below the passing threshold P=50. The cumulative failure count at prediction time t is:

\[F_{i,t}=\sum_{k<t}I(\bar{G}_{i,k}<P)\]

where I() is an indicator function. The current assessment is excluded from its own failure-history feature.

The available failure history at each prediction point is:

| Prediction point | Previous assessments used |
| ---------------- | ------------------------- |
| T1M              | None                      |
| T1F              | T1M                       |
| T2M              | T1M, T1F                  |
| T2F              | T1M, T1F, T2M             |
| T3M              | T1M, T1F, T2M, T2F        |

For modelling, cumulative failures may be grouped into categories of 0, 1, 2, and 3 or more.

Previous performance and cumulative failures provide complementary information: the former captures recent achievement, while the latter summarises repeated academic difficulty across earlier assessments. The failure count is derived from past outcomes and is therefore not an independent causal variable.

The failure penalty is defined as:

\[E^{failure}_{i,t}=-\delta F_{i,t}\]

with \(\delta=2\). This is a modelling assumption representing the influence of repeated academic difficulty on subsequent performance. Sensitivity analysis may be used to assess the effect of alternative penalty values.

## 11. Attendance × Previous Performance Interaction

A controlled nonlinear interaction was introduced so that the synthetic data are not purely additive.

The interaction is:

\[E^{interaction}_{i,s,t}=\gamma Z(G^*_{i,s,t-1})Z(Attendance_{i,t})\]

where:

\[Z(G^*)=\frac{G^*-\mu_s}{\sigma_s}\]

and:

\[Z(Attendance)=\frac{Attendance-Attendance_{reference}}{SD(Attendance)}\]

The current central value is:

\[\gamma=0.05\]

This interaction represents a small conditional effect in which the relationship between attendance and academic performance can vary according to previous performance. Its inclusion is a deliberate simulation assumption used to introduce a controlled nonlinear relationship. 

The interaction is validated by comparing the generated interaction term with the mathematically expected value for every subject and transition. This is preferable to attempting to discover the intentionally embedded interaction through a regression significance test.

The implementation validation confirmed the expected interaction mechanism across all subject-transition combinations.

## 12. Residual Variation

The residual component represents unexplained academic variation:

\[\epsilon_{i,s,t}\sim\mathcal{N}(0,\sigma_{\epsilon,s}^{2})\]

with:

\[\sigma_{\epsilon,s}=\sigma_s\sqrt{1-\lambda_s^2}\]

The residual variance was explicitly validated against the intended variance construction.

The validation showed that the reconstructed variance agrees with the configured target to numerical precision. This confirmed that the residual-variance calculation is implemented correctly.

## 13. Generation of Bounded Observed Scores

A simple clipping operation such as:

G=min(100,max(0,G\*))

was not used as the primary mechanism for producing observed grades.

Clipping could produce artificial accumulation exactly at 0 and 100 and could distort the distribution.

Instead, the latent score is converted into a probability through its standardized position and then mapped into the corresponding truncated-normal distribution between 0 and 100.

The resulting observed score is therefore bounded within:

\[0\le G_{i,s,t}\le100\]

while preserving the ordering of the latent scores.

The target subject mean and standard deviation are treated as **calibration targets**, not guarantees of the exact realised observed mean and SD. In particular, the truncation transformation naturally causes the realised SD to differ from the unbounded empirical target.

Validation of the generated scores therefore examines:

- mean;
- standard deviation;
- skewness;
- kurtosis;
- minimum;
- maximum;
- exact 0 and 100 rates; and
- near-boundary rates.

The current generated distributions show no exact 0 or 100 accumulation and very low near-boundary rates. The observed means remain close to the calibration means, while realised SDs are generally somewhat lower than the empirical target SDs because of the bounded transformation.

Differences in means, SDs, skewness, or kurtosis are treated as descriptive calibration diagnostics unless a threshold can be independently justified.

## 14. Problems Encountered and Implementation Refinements

Several issues were identified during implementation and addressed before proceeding to prediction modelling.

### 14.1 Handling of Kiswahili as an Unobserved Subject

Kiswahili is included in the synthetic dataset but is not directly represented in the Halabja Student Grade Dataset. Consequently, its parameters could not be treated as empirical observations from Halabja. Rather than relabelling an existing Halabja subject as Kiswahili, Kurdish and Arabic were used as language-subject proxies because both provide observed subject-level performance distributions and cross-subject relationships within the same empirical dataset. 

A transparent arithmetic-mean calibration rule was applied to derive the Kiswahili parameters. The mean was calculated from the Kurdish and Arabic means, giving **61.0** from (62.9+59.1)/2, while the SD was calculated from their reported SDs, giving **17.9** from (17.0+18.8)/2. For the common-factor loading, the average pairwise correlation strengths for Kurdish (**0.76**) and Arabic (**0.75**) were first averaged and then converted to a loading using the square-root relationship, giving **0.87**: sqrt{(0.76+0.75)/2}=0.87. These values are therefore **proxy-informed simulation calibration parameters**, not empirical estimates of Kiswahili performance or formal factor-analysis estimates. 

### 14.2 Latent and observed scores were initially insufficiently separated

Using bounded observed scores in the recursive equation could have caused artificial boundary effects to propagate through subsequent assessments.

The generator was therefore changed to maintain separate latent and observed scores. Recursion uses G\*, while the observed 0–100 score is generated afterwards.

### 14.3 Attendance boundary concentration

The initial improving attendance slope was too strong and produced excessive concentration near 100% in later periods.

The improving slope was reduced from +3 to +1.5 percentage points per period.

Validation is retained because even the revised configuration produces increasing near-100 proportions among improving students over time. This is monitored as a distributional diagnostic rather than being hidden through arbitrary clipping.

## 15. Current Simulation Parameters and Their Provenance

| Parameter                              | Current value           | Classification                         | Basis                                                                                                        |
| -------------------------------------- | ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Number of students                     | 5,000                   | Design choice                          | Project requirement                                                                                          |
| Number of subjects                     | 9                       | Design choice                          | Project benchmark                                                                                            |
| Number of assessments                  | 6                       | Design choice                          | Three terms × two assessments                                                                                |
| Pass mark                              | 50                      | Institutional assumption               | Outcome definition                                                                                           |
| β, previous-performance persistence    | 0.85                    | Empirically informed assumption        | Strong successive-grade relationships observed in UCI                                                        |
| α, attendance effect                   | 0.25                    | Evidence-informed assumption           | Attendance-achievement literature                                                                            |
| α sensitivity                          | 0.15, 0.25, 0.35        | Robustness configuration               | Plausible variation around central assumption                                                                |
| γ, interaction                         | 0.05                    | Modelling assumption                   | Controlled nonlinear mechanism                                                                               |
| δ, failure penalty                     | 2                       | Modelling assumption                   | Controlled longitudinal mechanism                                                                            |
| Ability distribution                   | N(0,1)​                 | Standardisation choice                 | Latent simulation design                                                                                     |
| Factor loadings                        | 0.68–0.87               | Calibration parameters                 | Relative Halabja cross-subject structure                                                                     |
| Subject means/SDs                      | Subject-specific        | Empirical calibration                  | Halabja                                                                                                      |
| Kiswahili mean/SD                      | 61.0 / 17.9             | Proxy-informed calibration parameters  | Arithmetic mean of Halabja Kurdish and Arabic subject means and SDs                                          |
| Kiswahili factor loading               | 0.87                    | Proxy-informed calibration parameters  | Derived from Halabja Kurdish and Arabic average pairwise correlations using the documented calibration rule  |
| Attendance baseline                    | Mean 90, SD 7           | Modelling assumption                   | Attendance simulation design                                                                                 |
| Attendance noise SD                    | 2                       | Modelling assumption                   | Attendance simulation design                                                                                 |
| Stable/Improving/Declining proportions | 60/20/20%               | Modelling assumption                   | Simplified longitudinal design                                                                               |
| Improving slope                        | +1.5                    | Revised modelling assumption           | Reduced after boundary validation                                                                            |
| Declining slope                        | −3                      | Modelling assumption                   | Longitudinal trajectory design                                                                               |
| Slope SD                               | 0.8                     | Modelling assumption                   | Longitudinal trajectory design                                                                               |
| Historical failures                    | Dynamically accumulated | Design refinement                      | Derived from previous assessment outcomes                                                                    |
| Noise features                         | 3 independent variables | Validation design                      | Test irrelevant-feature suppression                                                                          |

The distinction between these categories is important. A parameter is not labelled empirical merely because it was chosen after examining empirical data. Where the source did not permit direct estimation, the value remains explicitly identified as an assumption or calibration parameter.

## 16. Current Validation Framework

Validation is conducted before predictive-model evaluation.

### 16.1 Structural validation

The following are checked:

- correct number of students;
- unique student identifiers;
- expected number of subjects and assessments;
- no unintended missing values;
- finite scores;
- scores within 0–100;
- valid binary outcome;
- valid final-score calculation.

### 16.2 Distributional validation

For each subject and assessment:

- mean;
- SD;
- skewness;
- kurtosis;
- minimum;
- maximum;
- exact 0;
- exact 100;
- near 0;
- near 100.

The empirical Halabja values are used as calibration references, not as mandatory exact targets.

### 16.3 Cross-subject validation

The generated subject correlation matrix is examined to confirm:

- predominantly positive relationships;
- a cross-subject association structure consistent with a shared academic-performance component;
- broadly plausible relative strength compared with Halabja.

The objective is not to reproduce every empirical correlation exactly or to treat the observed correlations as formal factor-loading estimates. 

### 16.4 Longitudinal validation

Successive assessments are checked for positive persistence, consistent with the strong successive-grade relationships observed in the UCI data. 

The observed longitudinal correlations are not expected to equal exactly 0.85 because β applies to the latent recursive component and the observed scores additionally contain attendance, failure, interaction, residual variation, and bounded-score transformation.

### 16.5 Mechanism validation

The generator explicitly validates:

- ability effects;
- residual variance;
- longitudinal recursion;
- attendance effects;
- failure effects;
- synthetically specified interaction implementation. 

Mechanism validation is used to determine whether the intended mathematical structure was actually implemented rather than merely checking whether the final dataset looks plausible.

### 16.6 Behavioural validation

The following relationships are examined descriptively:

- attendance versus academic performance;
- historical failures versus academic performance;
- cross-subject dependence;
- longitudinal dependence;
- irrelevant noise versus outcome/performance.

The intended directions are more important than imposing arbitrary numerical thresholds that have no independent empirical justification.

## 17. Final Outcome Validation

The final score is the mean of the nine T3F subject scores:

\[\mathrm{FinalAverage}_i=\frac{1}{9}\sum_{s=1}^{9}G_{i,s,T3F}\]

The current generated dataset contains 5,000 students.

The observed final-score distribution has:

- mean = 56.97;
- SD = 13.52;
- median = 57.23;
- minimum = 8.24;
- maximum = 97.00.

Using a pass mark of 50:

- 1,516 students are classified as at risk;
- 3,484 are classified as non-risk;
- risk prevalence = 30.32%.

The prevalence is **not forced to a predetermined target**. It emerges from the interaction of the calibrated subject distributions and longitudinal mechanisms. It is therefore treated as a diagnostic outcome of the generator rather than a parameter that is manually adjusted to produce a desired class balance.

## 18. Prediction-Point Construction

After the synthetic dataset has passed the generator validation stage, five prediction datasets will be constructed:

T1M, T1F, T2M, T2F, T3M

Each snapshot will contain only variables available at that prediction point.

The temporal availability principle is:

| Prediction point | Information permitted |
| ---------------- | --------------------- |
| T1M              | T1M information       |
| T1F              | T1M + T1F information |
| T2M              | T1M–T2M information   |
| T2F              | T1M–T2F information   |
| T3M              | T1M–T3M information   |

T3F scores, final average, and At_Risk remain target information and cannot be predictors.

Derived variables such as previous performance and cumulative historical failures must likewise be constructed using only preceding information.

Generator-only variables such as latent ability, latent scores, attendance trajectory type, baseline attendance, slope, and latent attendance are not intended as model predictors.

## 19. Robustness and Sensitivity Analysis

The synthetic dataset should not be evaluated from only one arbitrary parameter configuration.

Sensitivity analysis will focus particularly on parameters that are assumptions rather than direct empirical estimates.

The central attendance effect is:

\[\alpha=0.25\]

with sensitivity configurations:

{0.15,0.25,0.35}

The persistence coefficient, interaction strength, failure penalty, attendance configuration, and other assumption-driven components **may similarly be varied in sensitivity analyses where their influence is material**. 

Multiple random seeds will also be used.

The purpose is not to search for a configuration that produces the best predictive performance. Instead, it is to determine whether the principal conclusions remain reasonably stable when plausible assumptions and stochastic realizations change.

Predictive performance will therefore be interpreted together with generator validation rather than being treated as evidence that a particular synthetic configuration is realistic.

## 20. Sensitivity Analysis

Sensitivity analysis was conducted to assess how changes in key modelling assumptions affect the generated academic outcomes and longitudinal relationships. The baseline configuration used an attendance effect (\(lpha=0.25\)), longitudinal persistence (\(eta=0.85\)), historical-failure penalty (\(\delta=2\)), and interaction strength (\(\gamma=0.05\)). Each parameter was varied individually while the others were held constant.

| Parameter            | Values tested    | Main observed effect                                                                                                    |
| -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Attendance effect (\(lpha\)) | 0.15, 0.25, 0.35 | Changed the relationship between attendance and academic performance, with relatively small changes in risk prevalence. |
| Persistence (\(eta\)) | 0.75, 0.85, 0.95 | Higher persistence increased measured longitudinal persistence and influenced final-score distributions.                |
| Failure penalty (\(\delta\)) | 1, 2, 3          | Produced the largest changes in mean final scores and academic-risk prevalence.                                         |
| Interaction (\(\gamma\)) | 0, 0.05, 0.10    | Had comparatively small effects on final outcomes and risk prevalence.                                                  |

The baseline configuration produced a mean final score of 49.28 and an academic-risk prevalence of 42.74%. These values describe the generated dataset and are not estimates of prevalence among Kenyan students.

Overall, the analysis indicated that the generator was most sensitive to the historical-failure penalty and longitudinal persistence. Attendance-effect changes influenced the attendance–performance relationship, while the interaction had comparatively limited effects on aggregate outcomes. The baseline parameter values were therefore retained provisionally, pending validation that the generated data reproduce the intended mechanisms and score distributions. In particular, the historical-failure calculation must consistently reflect completed assessment outcomes, with the penalty applied once per accumulated failure. The tested persistence values were 0.75 and 0.95 around the baseline of 0.85.

Because each configuration was evaluated using a single random seed, the observed differences may also reflect random variation. The results are consequently treated as a robustness check rather than definitive evidence that the selected parameters are uniquely optimal. Repeated-seed experiments can provide further evidence of stability.

## 21. Overall Methodological Position

The resulting generator follows a deliberately conservative principle:

**Empirical data constrain what can reasonably be claimed, while modelling assumptions are explicitly identified, validated, and subjected to sensitivity analysis.**

Halabja primarily informs subject-level score distributions and cross-subject structure, while UCI Student Performance data inform longitudinal persistence. Neither dataset is treated as a direct representation of the target Kenyan student population.

The generator incorporates longitudinal performance, separates latent from observed scores, controls subject dependence, models evolving attendance, and derives historical failures dynamically from previous assessment outcomes. It also includes a controlled nonlinear interaction, bounds scores without simple clipping, excludes future information from prediction snapshots, and validates both generated distributions and underlying mechanisms.

Sensitivity analysis examines the influence of key assumptions, particularly longitudinal persistence, attendance effects, historical-failure penalties, and interaction strength. The baseline parameters are retained provisionally, subject to further validation and reproducibility checks.

These methodological choices are intended to produce a transparent, reproducible synthetic benchmark for comparing prediction and explainability methods. Predictive performance on this dataset will indicate how well the methods recover the simulated relationships; it will not, by itself, establish real-world validity for Kenyan students.

## References

Dräger, J., Klein, M., & Sosu, E. M. (2025). Does the impact of pupil absences on achievement depend on their timing? *American Educational Research Journal*, *62*(5), 872-908.[ https://doi.org/10.3102/00028312251347666](https://doi.org/10.3102/00028312251347666)
