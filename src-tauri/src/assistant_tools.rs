//! Whitelisted function tools. No SQL, filesystem, network, or business apply tool.
use crate::assistant_operations::{self as ops, find, rows, text, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Connection, SqliteConnection};

fn tool(name: &str, description: &str, properties: Value, required: Vec<&str>) -> Value {
    json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})
}
pub fn definitions() -> Vec<Value> {
    let table = json!({"type":"string","enum":["projects","stages","tasks","schedules","events"]});
    let string = json!({"type":"string"});
    let strings = json!({"type":"array","items":{"type":"string"}});
    let nullable = |description: &str| json!({"type":["string","null"],"description":description});
    let fields = json!({"type":"object","additionalProperties":false,
    "description":"仅填写当前业务类型适用、且要设置或改变的字段；update未提及字段必须省略。新建标题必填，可根据明确意图拟定，不必向用户索要标题；新建关联日程省略标题时程序沿用任务标题。可选信息未提供就省略，不用空字符串代替日期/时间的空值，不得编造事实。阶段没有备注字段。",
    "properties":{
        "title":{"type":"string","minLength":1,"maxLength":300,"description":"记录标题，不是整组操作说明。新建时根据用户意图拟定；关联任务不代表已填写日程标题。"},
        "notes":{"type":"string","maxLength":20000,"description":"可选备注，未提供就省略；清空用空文本，不填null。"},
        "status":{"type":"string","enum":["todo","doing","done"]},
        "priority":{"type":"string","enum":["low","medium","high"]},
        "due_date":nullable("仅任务截止，本地YYYY-MM-DD；用户未指定时省略，不能用执行日期充当截止日期。"),
        "due_time":nullable("仅任务具体截止时刻HH:mm，需有截止日期；未指定留空。"),
        "project_id":nullable("任务或阶段关联项目的真实UUID，或同组新建项目ref；独立任务为null。"),
        "stage_id":nullable("任务关联阶段的真实UUID或同组ref，可选。"),
        "task_id":nullable("日程关联任务的真实UUID或同组ref，可选。"),
        "date":{"type":"string","description":"日程或事件的必填执行日期，本地YYYY-MM-DD；不能推测未明确的日期。"},
        "start_date":{"type":"string","description":"阶段必填开始日期YYYY-MM-DD。"},
        "end_date":{"type":"string","description":"阶段必填结束日期YYYY-MM-DD，不早于开始日期。"},
        "period":{"type":"string","enum":["anytime","morning","afternoon","evening","exact"],"description":"日程时段；上午/下午/晚上用对应模糊时段，不能凭空分配小时。"},
        "start_time":nullable("仅exact日程必填开始时刻HH:mm；模糊时段留空。"),
        "end_time":nullable("仅exact日程可选结束时刻HH:mm，必须晚于开始；未指定留空。"),
        "completed_at":nullable("日程执行完成时间戳；新建默认未执行，留空。任务完成与日程执行独立。"),
        "kind":{"type":"string","enum":["event","rest"],"description":"仅事件：普通重要事件或休息日。"}
    }});
    let mut patch_fields = fields.clone();
    patch_fields["description"] = json!("增量修改：仅填写本次用户明确要求改变的字段。即使原步骤是create，也不能重填整条记录。要求保留的备注、优先级等字段必须省略，由程序保留最新手动值；绝不能从历史回答抄回旧值。可选字段未提及则省略，不写null覆盖。清空备注用空文本。其余类型规则与fields一致。");
    let action = json!({"type":"object","properties":{"key":string,"action":{"type":"string","enum":["create","update","delete","archive","restore"]},"table":table,"id":{"type":"string","description":"已有对象的真实UUID；create不填，程序生成"},"ref":{"type":"string","description":"新对象临时引用名，用于同组关联"},"fields":fields,"shift_due_days":{"type":"integer","description":"仅任务update可用，相对数据库现有截止日按本地日历顺延，保留原时刻；不要同时填due_date"}},"required":["key","action","table"],"additionalProperties":false});
    vec![
        tool("query_records","实时查询本地项目/阶段/任务/日程/事件。每次重新读取SQLite，不依赖历史回答。任务含程序计算的逾期、剩余天数、已执行/未执行日程数量。先查询确定UUID再修改；名称相似不能代替真实关联。结果有total/has_more，需要时分页。",json!({"table":table,"ids":strings,"search":{"type":"string","description":"标题或备注包含文字"},"project_id":string,"stage_id":string,"task_id":string,"status":{"type":"string","enum":["todo","doing","done","unfinished"]},"execution":{"type":"string","enum":["pending","completed","all"]},"scope":{"type":"string","enum":["active","archived","all"]},"date_from":{"type":"string","description":"任务截止/日程日期/事件日期/阶段重叠起点"},"date_to":string,"overdue":{"type":"boolean"},"offset":{"type":"integer"},"limit":{"type":"integer","maximum":100}}),vec!["table"]),
        tool("get_workload","程序汇总一段日期内的任务截止、已执行与待执行日程、精确安排分钟、重要事件、休息日及重叠阶段。用于休假建议、负荷规划；无安排不等于完全空闲，不擅自假定模糊日程时长。最多62天。",json!({"date_from":string,"date_to":string}),vec!["date_from","date_to"]),
        tool("calculate_dates","只计算本地日历日期，不准备或修改业务记录。用户暂不修改、只问顺延后哪天时使用；保留原有时刻。",json!({"items":{"type":"array","maxItems":50,"items":{"type":"object","properties":{"date":string,"add_days":{"type":"integer"}},"required":["date","add_days"],"additionalProperties":false}}}),vec!["items"]),
        tool("prepare_operation","准备新的独立待确认操作，绝不直接写业务表。支持五类记录CRUD、项目/任务归档恢复和批量预览。未指定归属的新任务默认独立，不要为猜测归属查询无关项目和阶段。更新只填用户指定字段；级联影响由程序计算。成功后UI自动在本条回复下展示预览，必须用户确认才执行。修改已有预览用revise_operation，重新显示用present_operation，明确作废重做用replace_operation。",json!({"title":string,"actions":{"type":"array","items":action,"maxItems":50}}),vec!["title","actions"]),
        tool("list_operations","读取本对话独立操作及最新手动字段。每组含revision和pending/paused/applied/cancelled状态。暂停仍可修改，不可确认；已执行组有真实receipt。不重复把已执行组当草稿。",json!({"id":string}),vec![]),
        tool("revise_operation","修改同一待确认/暂停操作，保留未提到的字段和手动内容。patches按key合并fields；remove_keys移除步骤；add_actions新增步骤。shift_due_days相对原数据库截止。成功后最新版自动展示在本条回复下，旧位置变为只读引用，不需要用户上翻。需要最新revision。",json!({"id":string,"revision":{"type":"integer"},"title":string,"patches":{"type":"array","items":{"type":"object","properties":{"key":string,"fields":patch_fields,"shift_due_days":{"type":"integer"}},"required":["key"],"additionalProperties":false}},"remove_keys":strings,"add_actions":{"type":"array","items":action}}),vec!["id","revision"]),
        tool("present_operation","将已有待确认/暂停表单重新展示在本条回复下，不创建另一项任务、不改字段、状态或业务版本。用户说表单在哪/看不到/再给我显示或生成一个，在没有明确放弃原方案时必须使用本工具。旧位置收起为只读引用，手动内容保留；不能只list_operations然后叫用户刷新、上翻或找通知区。",json!({"id":string,"revision":{"type":"integer"}}),vec!["id","revision"]),
        tool("replace_operation","仅用户明确说原方案不要了/作废之前方案并重新做时使用。以原组为底稿按patches/remove_keys/add_actions调整；未提及的手动内容保留。原子生成新操作并将旧操作标为已替换，旧组再也不能确认。新方案无效时旧组保持有效。只想重新看表单请用present_operation，不要先cancel再prepare。",json!({"id":string,"revision":{"type":"integer"},"title":string,"patches":{"type":"array","items":{"type":"object","properties":{"key":string,"fields":patch_fields,"shift_due_days":{"type":"integer"}},"required":["key"],"additionalProperties":false}},"remove_keys":strings,"add_actions":{"type":"array","items":action}}),vec!["id","revision"]),
        tool("set_operation_state","暂停、继续或取消本对话中的待确认操作，绝不保存业务记录。用户说先别动/暂停用paused；继续准备用pending；明确不要这组才cancelled。不可执行applied。",json!({"id":string,"revision":{"type":"integer"},"state":{"type":"string","enum":["paused","pending","cancelled"]}}),vec!["id","revision","state"]),
        tool("remember_intent","记录用户已经明确的当前目标和约束，跨轮/重启保留。只记简短意图，不把推测当事实。已有实体指代由查询结果自动记录，不必反复问。",json!({"summary":{"type":"string","maxLength":1600}}),vec!["summary"]),
        tool("keep_operations","明确选择本轮不准备新操作、不改变已有操作。普通聊天、解释、只建议、要求保持不变，或必填信息存在实质歧义需澄清且无需查询时使用；即使没有待处理表单也可以使用。不读取业务数据，只读取本对话预览状态。不允许用它代替已经明确且信息足够的创建、修改、取消、暂停、继续、重新展示或替换请求，那些必须调用对应工具。",json!({}),vec![]),
    ]
}
pub fn label(name: &str) -> &str {
    match name {
        "query_records" => "查询工作台",
        "get_workload" => "分析日程负荷",
        "calculate_dates" => "核对日期",
        "prepare_operation" => "准备操作预览",
        "list_operations" => "读取最新操作",
        "revise_operation" => "更新操作预览",
        "present_operation" => "重新展示表单",
        "replace_operation" => "替换原方案",
        "set_operation_state" => "更新操作状态",
        "remember_intent" => "记住本次要求",
        "keep_operations" => "核对操作意图",
        _ => "未知工具",
    }
}
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Query {
    table: String,
    ids: Vec<String>,
    search: Option<String>,
    project_id: Option<String>,
    stage_id: Option<String>,
    task_id: Option<String>,
    status: Option<String>,
    execution: Option<String>,
    scope: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    overdue: Option<bool>,
    offset: usize,
    limit: Option<usize>,
}
pub async fn memory(conn: &mut SqliteConnection, conversation: &str) -> Result<Value> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM assistant_context WHERE conversation_id=?")
            .bind(conversation)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
    let parsed = value
        .map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "对话上下文损坏".to_string()))
        .unwrap_or(Ok(json!({})))?;
    if !parsed.is_object() {
        return Err("对话上下文损坏，请开启新对话".into());
    }
    Ok(parsed)
}
pub fn operation_summary(op: &Value) -> Value {
    let fields=op["preview"].as_array().map(|a|a.iter().map(|i|{
        let mut record=if i["after"].is_null(){i["before"].clone()}else{i["after"].clone()};
        if let Some(obj)=record.as_object_mut(){obj.remove("created_at");obj.remove("updated_at");if let Some(note)=obj.get("notes").and_then(Value::as_str){let note=note.chars().take(1000).collect::<String>();obj.insert("notes".into(),json!(note));}}
        json!({"key":i["key"],"table":i["table"],"action":i["action"],"id":i["id"],"current_preview":record})
    }).collect::<Vec<_>>()).unwrap_or_default();
    json!({"id":op["id"],"title":op["title"],"state":op["state"],"revision":op["revision"],"superseded_by":op["superseded_by"],"items":fields,"notes":"这是操作预览，不是当前数据库事实；长备注明确只显示摘要，修改未提及字段由本地合并保留。需要详情可list_operations(id)。"})
}
async fn save_memory(conn: &mut SqliteConnection, conversation: &str, value: &Value) -> Result<()> {
    sqlx::query("INSERT INTO assistant_context(conversation_id,value,updated_at) VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(conversation).bind(value.to_string()).bind(ops::stamp()).execute(&mut *conn).await.map_err(|e|e.to_string())?;
    Ok(())
}
pub fn task_facts(data: &Value, task: &Value, today: &str, now_time: &str) -> Value {
    let related: Vec<&Value> = rows(data, "schedules")
        .iter()
        .filter(|s| s["task_id"] == task["id"])
        .collect();
    let pending = related
        .iter()
        .filter(|s| s["completed_at"].is_null())
        .count();
    let due = text(task, "due_date");
    let unfinished = text(task, "status") != "done";
    let overdue = unfinished
        && !due.is_empty()
        && (due < today || due == today && task["due_time"].as_str().is_some_and(|t| t < now_time));
    let days = ops::date(due)
        .ok()
        .zip(ops::date(today).ok())
        .map(|(d, t)| (d - t).num_days());
    json!({"overdue":overdue,"days_until_due":days,"schedule_total":related.len(),"schedule_pending":pending,"schedule_completed":related.len()-pending,"has_pending_schedule":pending>0,"task_complete":!unfinished})
}
pub async fn query(
    conn: &mut SqliteConnection,
    conversation: &str,
    args: Value,
    today: &str,
    now_time: &str,
) -> Result<Value> {
    let q: Query = serde_json::from_value(args.clone()).map_err(|_| "查询参数无效")?;
    ops::columns(&q.table)?;
    if q.ids.len() > 100
        || q.offset > 100000
        || q.limit.is_some_and(|n| n == 0 || n > 100)
        || q.status
            .as_deref()
            .is_some_and(|s| !["todo", "doing", "done", "unfinished"].contains(&s))
        || q.scope
            .as_deref()
            .is_some_and(|s| !["active", "archived", "all"].contains(&s))
        || q.execution
            .as_deref()
            .is_some_and(|s| !["pending", "completed", "all"].contains(&s))
    {
        return Err("查询筛选参数无效".into());
    }
    for d in [&q.date_from, &q.date_to].into_iter().flatten() {
        ops::date(d)?;
    }
    if q.status.is_some() && q.table != "tasks"
        || q.execution.is_some() && q.table != "schedules"
        || q.overdue.is_some() && q.table != "tasks"
    {
        return Err(
            "状态和逾期筛选用于任务，执行状态筛选用于日程；任务的已执行/待执行数量见查询结果facts"
                .into(),
        );
    }
    if q.date_from
        .as_ref()
        .zip(q.date_to.as_ref())
        .is_some_and(|(a, b)| a > b)
    {
        return Err("查询结束日期不能早于开始日期".into());
    }
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let data = ops::load(&mut tx).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let mut matched:Vec<Value>=rows(&data,&q.table).iter().filter(|r| {
        if !q.ids.is_empty()&&!q.ids.iter().any(|id|id==text(r,"id")) {return false;}
        let enabled=ops::active(&data,&q.table,r);
        if match q.scope.as_deref().unwrap_or("active") {"active"=>!enabled,"archived"=>enabled,_=>false} {return false;}
        if q.search.as_ref().is_some_and(|s|!format!("{} {}",text(r,"title"),text(r,"notes")).to_lowercase().contains(&s.to_lowercase())) {return false;}
        for (field,filter) in [("project_id",&q.project_id),("stage_id",&q.stage_id),("task_id",&q.task_id)] {
            let value=if (field=="project_id"&&q.table=="projects") || (field=="stage_id"&&q.table=="stages") || (field=="task_id"&&q.table=="tasks"){text(r,"id")}else if field=="project_id"&&q.table=="schedules" {find(&data,"tasks",text(r,"task_id")).map(|t|text(t,field)).unwrap_or("")}else{text(r,field)};
            if filter.as_ref().is_some_and(|s|s!=value) {return false;}
        }
        if q.status.as_deref().is_some_and(|s|if s=="unfinished"{text(r,"status")=="done"}else{text(r,"status")!=s}) {return false;}
        if q.table=="schedules" && q.execution.as_deref().is_some_and(|s|s=="pending"&&!r["completed_at"].is_null()||s=="completed"&&r["completed_at"].is_null()) {return false;}
        let (start,end)=match q.table.as_str(){"tasks"=>(text(r,"due_date"),text(r,"due_date")),"stages"=>(text(r,"start_date"),text(r,"end_date")),_=>(text(r,"date"),text(r,"date"))};
        if (q.date_from.is_some()||q.date_to.is_some()) && start.is_empty() {return false;}
        if q.date_from.as_ref().is_some_and(|s|end<s.as_str()) || q.date_to.as_ref().is_some_and(|s|start>s.as_str()) {return false;}
        if q.overdue.is_some_and(|o|q.table!="tasks" || task_facts(&data,r,today,now_time)["overdue"]!=o) {return false;}
        true
    }).map(|r| {
        let mut r=r.clone();
        if text(&r,"notes").chars().count()>2000 {r["notes"]=json!(text(&r,"notes").chars().take(2000).collect::<String>());r["notes_truncated"]=json!(true);}
        if q.table=="tasks" {r["facts"]=task_facts(&data,&r,today,now_time);}
        if q.table=="schedules" {r["execution_state"]=json!(if r["completed_at"].is_null(){"pending"}else{"completed"}); if let Some(t)=find(&data,"tasks",text(&r,"task_id")){r["task_status"]=t["status"].clone();}}
        if q.table=="projects" {let tasks:Vec<_>=rows(&data,"tasks").iter().filter(|t|t["project_id"]==r["id"]).collect();r["progress"]=json!({"total":tasks.len(),"done":tasks.iter().filter(|t|text(t,"status")=="done").count()});}
        r
    }).collect();
    matched.sort_by_key(|r| {
        let d = if q.table == "tasks" {
            text(r, "due_date")
        } else if q.table == "stages" {
            text(r, "start_date")
        } else {
            text(r, "date")
        };
        (
            if d.is_empty() { "9999-12-31" } else { d }.to_string(),
            text(r, "id").to_string(),
        )
    });
    let total = matched.len();
    let selected: Vec<Value> = matched
        .into_iter()
        .skip(q.offset)
        .take(q.limit.unwrap_or(30))
        .collect();
    let mut m = memory(conn, conversation).await?;
    let mut recent = m["recent_queries"].as_array().cloned().unwrap_or_default();
    recent.push(json!({"table":q.table,"ids":selected.iter().map(|r|r["id"].clone()).collect::<Vec<_>>(),"filter":args,"total":total,"queried_at":ops::stamp()}));
    if recent.len() > 6 {
        recent.drain(..recent.len() - 6);
    }
    m["recent_queries"] = json!(recent);
    save_memory(conn, conversation, &m).await?;
    Ok(
        json!({"table":q.table,"total":total,"offset":q.offset,"returned":selected.len(),"has_more":q.offset+selected.len()<total,"as_of":ops::stamp(),"today":today,"records":selected}),
    )
}
async fn workload(
    conn: &mut SqliteConnection,
    args: &Value,
    today: &str,
    now_time: &str,
) -> Result<Value> {
    let from = ops::date(text(args, "date_from"))?;
    let to = ops::date(text(args, "date_to"))?;
    if to < from || (to - from).num_days() > 61 {
        return Err("请选择1至62天的日期范围".into());
    }
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let data = ops::load(&mut tx).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let mut days = vec![];
    let mut day = from;
    loop {
        let d = day.format("%Y-%m-%d").to_string();
        let schedules: Vec<Value> = rows(&data, "schedules")
            .iter()
            .filter(|r| text(r, "date") == d && ops::active(&data, "schedules", r))
            .cloned()
            .collect();
        let minutes: i64 = schedules
            .iter()
            .filter(|r| {
                r["completed_at"].is_null()
                    && text(r, "period") == "exact"
                    && !r["end_time"].is_null()
            })
            .map(|r| {
                let parse = |s: &str| chrono::NaiveTime::parse_from_str(s, "%H:%M").ok();
                parse(text(r, "end_time"))
                    .zip(parse(text(r, "start_time")))
                    .map(|(end, start)| (end - start).num_minutes().max(0))
                    .unwrap_or(0)
            })
            .sum();
        let due: Vec<Value> = rows(&data, "tasks")
            .iter()
            .filter(|r| {
                text(r, "due_date") == d
                    && text(r, "status") != "done"
                    && ops::active(&data, "tasks", r)
            })
            .cloned()
            .collect();
        let events: Vec<Value> = rows(&data, "events")
            .iter()
            .filter(|r| text(r, "date") == d)
            .cloned()
            .collect();
        let stages: Vec<Value> = rows(&data, "stages")
            .iter()
            .filter(|r| {
                text(r, "start_date") <= d.as_str()
                    && text(r, "end_date") >= d.as_str()
                    && ops::active(&data, "stages", r)
            })
            .cloned()
            .collect();
        days.push(json!({"date":d,"pending_schedules":schedules.iter().filter(|s|s["completed_at"].is_null()).count(),"completed_schedules":schedules.iter().filter(|s|!s["completed_at"].is_null()).count(),"exact_scheduled_minutes":minutes,"duration_is_estimate":false,"note":"精确时长为逐条相加，重叠可重复计入；模糊时段和无结束时间不计时长","schedules":schedules,"due_tasks":due,"events":events,"stages":stages}));
        if day == to {
            break;
        }
        day = day.succ_opt().ok_or("日期超出范围")?;
    }
    Ok(json!({"days":days,
            "backlog":{"unfinished_tasks":rows(&data,"tasks").iter().filter(|t|text(t,"status")!="done"&&ops::active(&data,"tasks",t)).map(|t|json!({"id":t["id"],"title":t["title"],"due_date":t["due_date"],"priority":t["priority"],"facts":task_facts(&data,t,today,now_time)})).take(100).collect::<Vec<_>>(),"past_pending_schedules":rows(&data,"schedules").iter().filter(|s|text(s,"date")<today&&s["completed_at"].is_null()&&ops::active(&data,"schedules",s)).take(100).collect::<Vec<_>>(),"limit":100},
            "as_of":ops::stamp(),"caution":"日历空白不等于完全空闲。还需考虑未完成工作、过期未执行安排和用户偏好，未确认前不能创建休息日。"}))
}
pub async fn execute(
    conn: &mut SqliteConnection,
    conversation: &str,
    message: &str,
    name: &str,
    args: Value,
    read_local: bool,
    today: &str,
    now_time: &str,
) -> Result<Value> {
    match name {
        "keep_operations" => Ok(
            json!({"operations":ops::list(conn,conversation).await?.iter().filter(|op|["pending","paused"].contains(&text(op,"state"))).map(|op|json!({"id":op["id"],"title":op["title"],"state":op["state"],"revision":op["revision"]})).collect::<Vec<_>>(),"business_changes":false}),
        ),
        "query_records" | "get_workload" if !read_local => {
            Err("当前未开启读取工作台，不能查询本地业务数据；可继续普通聊天或创建独立事项".into())
        }
        "query_records" => query(conn, conversation, args, today, now_time).await,
        "get_workload" => workload(conn, &args, today, now_time).await,
        "calculate_dates" => {
            let items = args["items"].as_array().ok_or("日期计算参数无效")?;
            if items.len() > 50 {
                return Err("一次最多计算50个日期".into());
            }
            let mut results = vec![];
            for item in items {
                let d = ops::date(text(item, "date"))?;
                let days = item["add_days"]
                    .as_i64()
                    .filter(|n| (-3650..=3650).contains(n))
                    .ok_or("日期偏移应在正负3650天内")?;
                let result = d
                    .checked_add_signed(chrono::Duration::days(days))
                    .ok_or("日期超出范围")?
                    .format("%Y-%m-%d")
                    .to_string();
                ops::date(&result)?;
                results.push(json!({"original":item["date"],"add_days":days,"result":result}));
            }
            Ok(json!({"dates":results,"business_changes":false}))
        }
        "list_operations" => {
            if let Some(id) = args["id"].as_str() {
                ops::get(conn, id, conversation).await
            } else {
                let mut all = ops::list(conn, conversation).await?;
                all.reverse();
                all.truncate(12);
                Ok(json!({"operations":all.iter().map(operation_summary).collect::<Vec<_>>()}))
            }
        }
        "prepare_operation" => {
            let actions = args["actions"].as_array().ok_or("操作列表无效")?;
            authorize(actions, read_local)?;
            ops::prepare(
                conn,
                conversation,
                message,
                text(&args, "title"),
                actions,
                None,
            )
            .await
        }
        "present_operation" => {
            ops::present(
                conn,
                conversation,
                text(&args, "id"),
                args["revision"].as_i64().ok_or("请提供最新预览版本")?,
                message,
            )
            .await
        }
        "revise_operation" | "replace_operation" => {
            let id = text(&args, "id");
            let old = ops::get(conn, id, conversation).await?;
            let revision = args["revision"].as_i64().ok_or("请读取最新操作版本")?;
            if old["revision"] != revision {
                return Err("操作已变化，请读取最新表单后继续".into());
            }
            let mut actions = old["actions"].as_array().cloned().ok_or("操作格式无效")?;
            if let Some(remove) = args["remove_keys"].as_array() {
                for key in remove {
                    if !actions.iter().any(|a| a["key"] == *key) {
                        return Err("要移除的步骤不存在".into());
                    }
                }
                actions.retain(|a| !remove.contains(&a["key"]));
            }
            if let Some(patches) = args["patches"].as_array() {
                for p in patches {
                    let a = actions
                        .iter_mut()
                        .find(|a| a["key"] == p["key"])
                        .ok_or("要修改的步骤不存在")?;
                    if let Some(fields) = p["fields"].as_object() {
                        if !a["fields"].is_object() {
                            a["fields"] = json!({});
                        }
                        for (k, v) in fields {
                            a["fields"][k] = v.clone();
                        }
                    }
                    if p["shift_due_days"].is_i64() {
                        a["shift_due_days"] = p["shift_due_days"].clone();
                        if let Some(f) = a["fields"].as_object_mut() {
                            f.remove("due_date");
                        }
                    }
                }
            }
            if let Some(add) = args["add_actions"].as_array() {
                actions.extend(add.clone());
            }
            authorize(&actions, read_local)?;
            let title = args["title"].as_str().unwrap_or(text(&old, "title"));
            if name == "replace_operation" {
                ops::replace_operation(conn, conversation, message, title, &actions, id, revision)
                    .await
            } else {
                ops::prepare(
                    conn,
                    conversation,
                    message,
                    title,
                    &actions,
                    Some((id, revision)),
                )
                .await
            }
        }
        "set_operation_state" => {
            ops::transition_at(
                conn,
                conversation,
                text(&args, "id"),
                args["revision"].as_i64().ok_or("操作版本无效")?,
                text(&args, "state"),
                Some(message),
            )
            .await
        }
        "remember_intent" => {
            let summary = text(&args, "summary");
            if summary.chars().count() > 1600 {
                return Err("本次要求过长，请简要记录".into());
            }
            let mut m = memory(conn, conversation).await?;
            m["intent"] = json!(summary);
            save_memory(conn, conversation, &m).await?;
            Ok(json!({"remembered":true}))
        }
        _ => {
            Err("此工具不存在。请使用已提供的业务工具；不能执行SQL、代码或直接保存业务记录".into())
        }
    }
}
fn authorize(actions: &[Value], read_local: bool) -> Result<()> {
    if !read_local
        && actions.iter().any(|a| {
            text(a, "action") != "create"
                || ["project_id", "stage_id", "task_id"].iter().any(|f| {
                    a["fields"][*f]
                        .as_str()
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                })
        })
    {
        return Err(
            "修改已有记录或关联现有对象需要开启读取工作台；独立新建和同组新建关联仍可使用".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_execution_does_not_complete_or_unschedule_task() {
        let task = json!({"id":"task","status":"todo","due_date":"2026-11-15","due_time":"23:59"});
        let data = json!({"schedules":[{"task_id":"task","completed_at":"2026-11-15T08:48:00Z"}]});
        let f = task_facts(&data, &task, "2026-11-16", "00:45");
        assert_eq!(f["schedule_total"], 1);
        assert_eq!(f["schedule_pending"], 0);
        assert_eq!(f["schedule_completed"], 1);
        assert_eq!(f["overdue"], true);
        assert_eq!(f["task_complete"], false);
    }
    #[test]
    fn same_day_exact_deadline_and_date_only_are_distinct() {
        let data = json!({});
        let mut t = json!({"status":"todo","due_date":"2026-11-16","due_time":null});
        assert_eq!(
            task_facts(&data, &t, "2026-11-16", "23:59")["overdue"],
            false
        );
        t["due_time"] = json!("10:00");
        assert_eq!(
            task_facts(&data, &t, "2026-11-16", "11:00")["overdue"],
            true
        );
    }
}
