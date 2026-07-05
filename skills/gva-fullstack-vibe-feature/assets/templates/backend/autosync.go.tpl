package autosync

import (
	sysModel "{{GO_MODULE}}/model/system"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── Route ──

type Route struct {
	Method   string
	Path     string
	Desc     string
	ApiGroup string
}

func (r *Route) SetDesc(s string) *Route {
	r.Desc = s
	return r
}

// ── Menu ──

type Menu struct {
	Name      string // 唯一键
	Title     string // 菜单显示名
	Icon      string // 图标
	Parent    string // 父菜单 name，空=顶级
	Component string // 前端文件路径，默认 "view/{name}/index.vue"
	Sort      int
}

// ── Registry ──

var routeRegistry []*Route
var menuRegistry []Menu

// ── AutoApiGroup ──

type AutoApiGroup struct {
	*gin.RouterGroup
	basePath string
	apiGroup string
}

func NewAutoApiGroup(group *gin.RouterGroup, db *gorm.DB, basePath string) *AutoApiGroup {
	return &AutoApiGroup{RouterGroup: group, basePath: basePath}
}

func (g *AutoApiGroup) SetApiGroup(s string) *AutoApiGroup {
	g.apiGroup = s
	return g
}

// ── HTTP 方法 ──

func (g *AutoApiGroup) POST(path string, handler gin.HandlerFunc) *Route {
	g.RouterGroup.POST(path, handler)
	r := &Route{Method: "POST", Path: g.basePath + "/" + path, ApiGroup: g.apiGroup}
	routeRegistry = append(routeRegistry, r)
	return r
}

func (g *AutoApiGroup) GET(path string, handler gin.HandlerFunc) *Route {
	g.RouterGroup.GET(path, handler)
	r := &Route{Method: "GET", Path: g.basePath + "/" + path, ApiGroup: g.apiGroup}
	routeRegistry = append(routeRegistry, r)
	return r
}

func (g *AutoApiGroup) PUT(path string, handler gin.HandlerFunc) *Route {
	g.RouterGroup.PUT(path, handler)
	r := &Route{Method: "PUT", Path: g.basePath + "/" + path, ApiGroup: g.apiGroup}
	routeRegistry = append(routeRegistry, r)
	return r
}

func (g *AutoApiGroup) DELETE(path string, handler gin.HandlerFunc) *Route {
	g.RouterGroup.DELETE(path, handler)
	r := &Route{Method: "DELETE", Path: g.basePath + "/" + path, ApiGroup: g.apiGroup}
	routeRegistry = append(routeRegistry, r)
	return r
}

// ── EnsureMenu ──

func EnsureMenu(m Menu) {
	if m.Component == "" {
		m.Component = "view/" + m.Name + "/index.vue"
	}
	menuRegistry = append(menuRegistry, m)
}

// ── Flush ──

func Flush(db *gorm.DB) {
	for _, r := range routeRegistry {
		db.Where("path = ? AND method = ?", r.Path, r.Method).
			FirstOrCreate(&sysModel.SysApi{
				Path:        r.Path,
				Method:      r.Method,
				ApiGroup:    r.ApiGroup,
				Description: r.Desc,
			})
	}
	routeRegistry = nil
}

func FlushMenus(db *gorm.DB) {
	for _, m := range menuRegistry {
		var parentId uint
		if m.Parent != "" {
			var p sysModel.SysBaseMenu
			db.Where("name = ?", m.Parent).First(&p)
			parentId = p.ID
		}

		menu := sysModel.SysBaseMenu{
			ParentId:  parentId,
			Name:      m.Name,
			Path:      m.Name,
			Component: m.Component,
			Sort:      m.Sort,
			Meta:      sysModel.Meta{Title: m.Title, Icon: m.Icon},
		}
		db.Where("name = ?", m.Name).FirstOrCreate(&menu)

		var admin sysModel.SysAuthority
		db.Where("authority_id = ?", 888).First(&admin)
		db.Model(&admin).Association("SysBaseMenus").Append(&menu)
	}
	menuRegistry = nil
}
