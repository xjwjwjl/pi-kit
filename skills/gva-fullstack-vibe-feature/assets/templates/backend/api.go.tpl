package {{MODULE}}

import (
	"{{GO_MODULE}}/model/common/response"
	moduleReq "{{GO_MODULE}}/model/{{MODULE}}/request"
	moduleService "{{GO_MODULE}}/service/{{MODULE}}"
	"{{GO_MODULE}}/utils/autosync"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

type Api struct {
	svc *moduleService.Service
	log *zap.Logger
}

func NewApi(svc *moduleService.Service, log *zap.Logger) *Api {
	return &Api{
		svc: svc,
		log: log.Named("{{MODULE}}-api"),
	}
}

func Register(private, public *gin.RouterGroup, db *gorm.DB, log *zap.Logger) {
	api := NewApi(moduleService.NewService(db, log), log)

	g := autosync.NewAutoApiGroup(private.Group("{{ROUTE_PREFIX}}"), db, "/{{ROUTE_PREFIX}}").
		SetApiGroup("{{PASCAL}}")

	g.POST("list", api.List)
	g.POST("create", api.Create).SetDesc("创建")
	g.PUT("update", api.Update).SetDesc("更新")
	g.DELETE("delete", api.Delete).SetDesc("删除")

	autosync.EnsureMenu(autosync.Menu{
		Name:   "{{MODULE}}",
		Title:  "{{PASCAL}}管理",
		Icon:   "box",
		Parent: "",
		Sort:   10,
	})
}

// ── Handlers ──

func (a *Api) List(c *gin.Context) {
	var req moduleReq.List{{PASCAL}}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.FailWithMessage(err.Error(), c)
		return
	}

	list, total, err := a.svc.List(c.Request.Context(), req)
	if err != nil {
		a.log.Error("list {{MODULE}} failed", zap.Error(err))
		response.FailWithMessage("获取失败", c)
		return
	}

	response.OkWithDetailed(response.PageResult{
		List:     list,
		Total:    total,
		Page:     req.Page,
		PageSize: req.PageSize,
	}, "获取成功", c)
}

func (a *Api) Create(c *gin.Context) {
	var req moduleReq.Create{{PASCAL}}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.FailWithMessage(err.Error(), c)
		return
	}

	if err := a.svc.Create(c.Request.Context(), req); err != nil {
		a.log.Error("create {{MODULE}} failed", zap.Error(err))
		response.FailWithMessage("创建失败", c)
		return
	}

	response.OkWithMessage("创建成功", c)
}

func (a *Api) Update(c *gin.Context) {
	var req moduleReq.Update{{PASCAL}}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.FailWithMessage(err.Error(), c)
		return
	}

	if err := a.svc.Update(c.Request.Context(), req); err != nil {
		a.log.Error("update {{MODULE}} failed", zap.Error(err))
		response.FailWithMessage("更新失败", c)
		return
	}

	response.OkWithMessage("更新成功", c)
}

func (a *Api) Delete(c *gin.Context) {
	var req moduleReq.Delete{{PASCAL}}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.FailWithMessage(err.Error(), c)
		return
	}

	if err := a.svc.Delete(c.Request.Context(), req); err != nil {
		a.log.Error("delete {{MODULE}} failed", zap.Error(err))
		response.FailWithMessage("删除失败", c)
		return
	}

	response.OkWithMessage("删除成功", c)
}
