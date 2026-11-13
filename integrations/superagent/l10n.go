package main

import "strings"

// Source-facing names stay English; rendered UI follows the caller's locale.
var messages = map[string][3]string{
	"title":         {"Task supervisor", "任务监督器", "タスク監督"},
	"setup":         {"Select one computer in this extension's settings. DSH Super-agent must already be running there.", "请在扩展设置中选择一台电脑，并先在该电脑运行 DSH Super-agent。", "拡張機能の設定でコンピューターを1台選択し、そこで DSH Super-agent を起動してください。"},
	"invalid":       {"This action or page state is invalid. Reopen the page.", "操作或页面状态无效，请重新打开页面。", "操作またはページの状態が無効です。ページを開き直してください。"},
	"unavailable":   {"Cannot read the supervisor. Check the selected computer, local port, and service status. No upstream error details are displayed.", "无法读取监督器。请检查所选电脑、本地端口和服务状态。这里不会显示上游错误详情。", "監督サービスを読み取れません。選択したコンピューター、ローカルポート、サービスの状態を確認してください。上流のエラー詳細は表示しません。"},
	"control_error": {"Control was not confirmed. Its outcome may be unknown; refresh and inspect the supervisor before deciding whether to try again. Nothing was retried automatically.", "未确认操作成功，结果可能未知。请刷新并检查监督器后，再决定是否重试。系统未自动重试。", "操作の成功を確認できません。結果が不明な可能性があります。更新して状態を確認し、再試行するか判断してください。自動再試行は行っていません。"},
	"accepted":      {"Supervisor confirmed the control request.", "监督器已确认操作请求。", "監督サービスが操作を確認しました。"},
	"refresh":       {"Refresh", "刷新", "更新"}, "back": {"Back to tickets", "返回工单", "チケット一覧へ"},
	"ticket": {"Ticket", "工单", "チケット"}, "tickets": {"Tickets", "工单", "チケット"},
	"id": {"Ticket ID", "工单 ID", "チケット ID"}, "stage": {"Stage", "阶段", "段階"},
	"assignments": {"Assignments", "执行轮次", "割り当て数"}, "inputs": {"Inputs", "输入数量", "入力数"},
	"undelivered": {"Undelivered inputs", "未送达输入", "未配信の入力"},
	"created":     {"Created (UTC)", "创建时间（UTC）", "作成日時（UTC）"}, "updated": {"Updated (UTC)", "更新时间（UTC）", "更新日時（UTC）"},
	"detail_note": {"Metadata only. Transcripts, prompts, environment variables, account details and raw errors remain on the supervisor computer.", "仅显示元数据。对话、提示词、环境变量、账户详情与原始错误保留在监督器电脑上。", "メタデータのみです。会話、プロンプト、環境変数、アカウント詳細、生のエラーは監督サービスのコンピューターに残ります。"},
	"readonly":    {"Read-only. Controls are disabled in settings.", "只读模式。设置中未启用控制操作。", "読み取り専用です。設定で操作が無効になっています。"},
	"controls_on": {"Controls enabled. Each operation asks for confirmation.", "已启用控制。每次操作均需确认。", "操作が有効です。毎回確認が必要です。"},
	"intake":      {"New requests and replies enter through the supervisor's configured Feishu/GitHub sources, not this panel. One page shows at most 20 tickets.", "新请求和回复请通过监督器已配置的飞书或 GitHub 来源发送，不能从此面板发送。每页最多显示 20 个工单。", "新しい依頼や返信は、この画面ではなく、監督サービスに設定済みの Feishu/GitHub から送信してください。1ページ最大20件です。"},
	"filter":      {"Filter", "筛选", "絞り込み"}, "open": {"Open", "未结束", "未終了"},
	"person": {"Needs a person", "等待人工", "人の対応待ち"}, "working": {"Working", "工作中", "作業中"},
	"idle": {"Idle", "空闲", "待機中"}, "ended": {"Ended", "已结束", "終了"},
	"delivery": {"Delivery issue", "投递异常", "配信の問題"}, "answer": {"Answer needed", "需要回答", "回答待ち"},
	"review": {"Review needed", "需要审查", "レビュー待ち"}, "blocked": {"Blocked", "受阻", "ブロック中"},
	"failed": {"Failed", "失败", "失敗"}, "queued": {"Queued", "排队中", "キュー待ち"},
	"active": {"Active", "运行中", "稼働中"}, "paused": {"Paused", "已暂停", "一時停止中"},
	"executor": {"Executor", "执行器", "実行サービス"}, "status": {"Status", "状态", "状態"},
	"running": {"Running workers", "运行中的执行单元", "実行中のワーカー"}, "workers": {"Worker limit", "执行单元上限", "ワーカー上限"},
	"empty": {"No tickets on this page.", "此页没有工单。", "このページにチケットはありません。"},
	"next":  {"Next page", "下一页", "次のページ"}, "previous": {"Previous page", "上一页", "前のページ"},
	"retry": {"Retry ticket", "重试工单", "チケットを再試行"}, "stop": {"Stop ticket", "停止工单", "チケットを停止"},
	"pause": {"Pause executor", "暂停执行器", "実行を一時停止"}, "resume": {"Resume executor", "恢复执行器", "実行を再開"},
	"confirm_retry":  {"Retry this ticket? It may run tools and change the project using the supervisor's existing permissions.", "重试此工单？它可能使用监督器的现有权限运行工具并修改项目。", "このチケットを再試行しますか？監督サービスの既存の権限でツールの実行やプロジェクトの変更が行われる可能性があります。"},
	"confirm_stop":   {"Stop this ticket? This is not an undo of changes already made.", "停止此工单？此操作不会撤销已经发生的修改。", "このチケットを停止しますか？すでに行われた変更は元に戻りません。"},
	"confirm_pause":  {"Pause the supervisor's executor? This does not guarantee cancellation of work already in progress.", "暂停监督器执行器？这不保证取消已经进行中的工作。", "監督サービスの実行を一時停止しますか？進行中の作業が取り消されるとは限りません。"},
	"confirm_resume": {"Resume the supervisor's executor? Queued work may begin and change projects.", "恢复监督器执行器？排队中的工作可能开始并修改项目。", "監督サービスの実行を再開しますか？キューの作業が開始され、プロジェクトが変更される可能性があります。"},
}

func translate(locale string) func(string) string {
	index := 0
	if strings.HasPrefix(strings.ToLower(locale), "zh") {
		index = 1
	}
	if strings.HasPrefix(strings.ToLower(locale), "ja") {
		index = 2
	}
	return func(key string) string {
		if value, ok := messages[key]; ok {
			return value[index]
		}
		return messages["invalid"][index]
	}
}
