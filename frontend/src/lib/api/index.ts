// Re-export client
export { default as api } from './client'
export { default } from './client'
export { setCsrfToken, ApiError } from './client'
export { extractApiError } from './error-utils'

// Auth
export { authApi } from './auth'
export type { User, AuthStatus, Coder } from './auth'

// Projects
export { projectsApi } from './projects'
export type { Project, ProjectSummary, RecentConversation, RecentDataset, RecentDocument } from './projects'

// Conversations
export { conversationsApi } from './conversations'
export type { Conversation } from './conversations'

// Media (audio/video)
export { mediaApi } from './media'
export type { MediaUploadResponse } from './media'

// Segments
export { segmentsApi } from './segments'
export type { Segment, SegmentNoteInfo, SegmentExcerptInfo, AppliedCodeDetail } from './segments'

// Codes & Categories
export { codesApi, categoriesApi } from './codes'
export type { Code, CodeCategory, CategoryMergeResponse, CategoryBulkMoveResponse } from './codes'

// Coding
export { codingApi } from './coding'

// Speakers
export { speakersApi } from './speakers'
export type { Speaker } from './speakers'

// Participants
export { participantsApi } from './participants'
export type {
  Participant,
  ParticipantDetail,
  LinkedSpeakerInfo,
  DatasetRowInfo,
  LinkedDemographicValue,
  LinkableRow,
} from './participants'

// Notes
export { notesApi, allNotesApi } from './notes'
export type {
  Note,
  AllNotesConvNote,
  AllNotesSpeaker,
  AllNotesConversation,
  AllNotesCommentNote,
  AllNotesRow,
  AllNotesColumn,
  AllNotesResponse,
} from './notes'

// Memos
export { memosApi } from './memos'
export type { Memo } from './memos'

// Excerpts
export { excerptsApi } from './excerpts'
export type {
  ExcerptNoteInfo,
  ExcerptResponse,
  ExcerptDetailResponse,
  QuotedExcerptCode,
  QuotedExcerptItem,
  QuotedExcerptsResponse,
  QuotedExcerptsParams,
} from './excerpts'

// Datasets & Recode
export { datasetsApi, recodeApi } from './datasets'
export type {
  DatasetColumnPreview,
  DatasetPreviewResponse,
  DatasetColumnConfig,
  DatasetImportConfig,
  DatasetImportResponse,
  Dataset,
  DatasetList,
  RecodeDefinition,
  RecodeDefinitionSummary,
  ValueFrequency,
  ColumnFrequenciesResponse,
  CopyToResponse,
  DatasetColumn,
  DatasetValueCell,
  DatasetDataRow,
  DatasetDataResponse,
  LinkParticipantResponse,
  BulkLinkResultItem,
  BulkLinkSkippedItem,
  BulkLinkResponse,
  ManualColumnCreate,
  ManualColumnUpdate,
  ComputedColumnCreate,
  ComputedColumnUpdate,
  ComputedPreviewRow,
  ComputedPreviewResponse,
  DomainScoreColumn,
  DomainScoresResponse,
  ValueUpdate,
  ValueCellResponse,
  AppendMatchedColumn,
  AppendUnmatchedCsvColumn,
  AppendUnmatchedColumn,
  AppendPreviewRow,
  DatasetAppendPreviewResponse,
  DatasetAppendResponse,
  ParticipantLinkReport,
  ProjectColumnInfo,
  ProjectColumnListResponse,
} from './datasets'

// Crosswalk (Path A — atomic move-members)
export { crosswalkApi } from './crosswalk'
export type {
  MoveMembersRequest,
  MoveMembersResponse,
  MoveMembersTargetMode,
} from './crosswalk'

// Equivalence Groups
export { equivalenceApi } from './equivalence'
export type {
  EquivalenceGroupColumnDefInfo,
  EquivalenceGroupColumnInfo,
  EquivalenceGroupResponse,
  EquivalenceGroupListResponse,
  BulkCreateResult,
  SuggestedGroupColumn,
  SuggestedGroup,
  EquivalenceSuggestResponse,
  ColumnMatchResult,
  FindMatchesResponse,
} from './equivalence'

// Analysis Domains
export { domainsApi } from './analysis-domains'
export type {
  DomainMemberInput,
  DomainMemberInfo,
  AnalysisDomainResponse,
  AnalysisDomainListResponse,
  BulkDomainCreateResult,
  DomainSuggestedItem,
  DomainSuggestion,
  DomainSuggestResponse,
} from './analysis-domains'

// Metrics
export { metricsApi } from './metrics'
export type {
  MetricType,
  InputSourceType,
  GroupingMode,
  ComputedResultResponse,
  MetricDefinitionResponse,
  MetricDefinitionSummaryResponse,
  MetricListResponse,
  ComputeAllResponse,
  QuickComputeSource,
  QuickComputeRequest,
  QuickComputeResponse,
  AnalysisColumnItem,
  AnalysisDatasetGroup,
  AnalysisDomainItem,
  AnalysisDemographicItem,
  AnalysisColumnsResponse,
  AnalysisCrossTabCell,
  ChiSquareResult,
  AnalysisCrossTabResponse,
  MatrixColumnInfo,
  MatrixRowItem,
  RowMatrixResponse,
} from './metrics'

// Materials
export { materialsApi } from './materials'
export type {
  MaterialCollectionResponse,
  MaterialCollectionListResponse,
  MaterialResponse,
  MaterialCollectionDetailResponse,
} from './materials'

// Correlations
export { correlationsApi } from './correlations'
export type {
  CorrelationCell,
  CorrelationMatrixResponse,
  RegressionResult,
  ScatterDataResponse,
  ScatterPair,
  ScatterMatrixResponse,
} from './correlations'

// Comparisons
export { comparisonsApi } from './comparisons'
export type {
  GroupStat,
  TestResult,
  ComparisonRow,
  GroupComparisonResponse,
} from './comparisons'

// Statistical Tests
export { statisticalTestsApi } from './statistical-tests'
export type {
  StatisticalTestResponse,
  StatisticalTestListResponse,
  ComputeAllTestsResponse,
} from './statistical-tests'

// Code Analysis
export { codeAnalysisApi } from './code-analysis'
export type {
  CodeFrequencyItem,
  CodeFrequencySummary,
  ContextSegment,
  CodedSegmentWithContext,
  ConversationSegmentGroup,
  CodeSegmentsWithContextResponse,
  DemographicFilterValue,
  DemographicFilter,
  ConversationOption,
  DemographicFilterOptionsResponse,
  CooccurrenceCodeInfo,
  CooccurrenceMatrixResponse,
  CodedTextInfo,
  DatasetTextGroup,
  CodeTextsResponse,
  CodeAnalysisFilterParams,
  SourceFrequenciesRequest,
  CodeCountEntry,
  SourceGroupData,
  SourceEntry,
  SourceFrequenciesTotals,
  CodeInfo,
  SourceFrequenciesResponse,
  DemographicComparisonRequest,
  GroupTotal,
  GroupCodeStats,
  StatTestResult,
  CodeComparisonEntry,
  DemographicComparisonResponse,
  SaturationPoint,
  SaturationResponse,
  TextColumnInfo,
  ConsensusStatus,
  ReconciliationCoder,
  ReconciliationCodeInfo,
  ReconciliationConsensusContext,
  ReconciliationUnit,
  ReconciliationResponse,
  ReconciliationParams,
  RecomputeConsensusResponse,
  IrrCoderInfo,
  IrrCodeResult,
  IrrThresholds,
  IrrResponse,
  IrrParams,
} from './code-analysis'

// Text Coding
export { textCodingApi } from './text-coding'
export type {
  TextQueryParams,
  TextCodingResponse,
  TextCodingListResponse,
  TextCodingRecord,
  RecordsListResponse,
  RecordContext,
  TextCodingColumn,
  CodingProgress,
  TextCodingViewConfig,
} from './text-coding'

// Text Analysis
export { textAnalysisApi } from './text-analysis'
export type {
  SubgroupFilter,
  CodeFrequencyBrief,
  FrequencySet,
  FilteredFrequenciesResponse,
  CrossTabRow,
  CrossTabulationResponse,
  CodeDensityGroup,
  CodeDensityResponse,
  ResponseLengthCode,
  ResponseLengthResponse,
} from './text-analysis'

// Search
export { searchApi } from './search'
export type {
  SegmentSearchResult,
  CodeSearchResult,
  ConversationSearchResult,
  NoteSearchResult,
  MemoSearchResult,
  DocumentSearchResult,
  TextSearchResult,
  CanvasSearchResult,
  SearchResults,
  SearchResponse,
  SearchEntityType,
} from './search'

// Export
export { exportApi } from './export'
export type { ExportOptions } from './export'

// Scratchpad
export { scratchpadApi } from './scratchpad'
export type { ScratchpadEntry } from './scratchpad'

// Data Quality
export { dataQualityApi } from './data-quality'
export type {
  VariableMissingSummary,
  MissingSummaryResponse,
  PatternRow,
  MissingPatternsResponse,
  McarEligibility,
  McarTestResult,
  McarTestResponse,
  DataQualityRequestBody,
} from './data-quality'

// Quote Board
export { quoteBoardApi } from './quote-board'
export type { QuoteBoardConfig } from './quote-board'

// Documents
export { documentsApi } from './documents'
export type {
  DocumentListItem,
  DocumentSegmentResponse,
  DocumentDetailResponse,
  DocumentImportResultItem,
  SegmentationPreviewSegment,
  SegmentationPreviewResponse,
  DocumentNote,
} from './documents'

// Codebook
export { codebookApi } from './codebook'
export type {
  CodebookTreeResponse,
  CodebookCategoryNode,
  CodebookCodeNode,
} from './codebook'

// Backup
export { backupApi } from './backup'
export type {
  BackupManifest,
  BackupStatus,
  BackupInfo,
  RestorePreview,
  ProjectBackupSummary,
} from './backup'

// Canvas
export { canvasApi } from './canvas'
export type {
  CanvasListItem,
  CanvasTheme,
  CanvasThemeRelationship,
  CanvasDetail,
  PendingItem,
  CanvasSnapshot,
  SnapshotDetail,
  SnapshotTheme,
  SnapshotRelationship,
  ThemeCreateRequest,
  ThemeUpdateRequest,
} from './canvas'

// Project Portability
export { projectPortabilityApi } from './project-portability'
export type {
  ProjectExportManifest,
  ImportValidationResult,
  ProjectImportResult,
  CodebookImportResult,
  ExistingProjectInfo,
  ProjectImportMode,
  MergeCoderMatch,
  MergeCoderPreview,
  MergeReport,
  MergeDivergenceDetail,
  CoderMapping,
  CoderMappingDecision,
  MergeCodeCandidate,
  MergeCodePreview,
  CodeMapping,
  CodeMappingDecision,
} from './project-portability'
