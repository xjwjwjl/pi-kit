// menu.go — 放置于 {server}/utils/autosync/ 目录下。
// 提供 MenuItem + FlushMenus 菜单声明式同步功能，独立于 api.go。
package autosync

import (
	"fmt"

	"your-project/model/sys"

	"gorm.io/gorm"
)

const defaultAdminAuthority = "1"

type MenuItem struct {
	RouteName string
	Title     string
	Icon      string
	Sort      int
	Component string
	Children  []MenuItem
}

func (m MenuItem) Sub(children ...MenuItem) MenuItem {
	m.Children = children
	return m
}

func FlushMenus(db *gorm.DB, items ...MenuItem) error {
	return flushMenusRecursive(db, "0", defaultAdminAuthority, items, 0)
}

func flushMenusRecursive(db *gorm.DB, parentID string, adminID string, items []MenuItem, depth int) error {
	for i, item := range items {
		icon := item.Icon
		if icon == "" {
			icon = "aim"
		}
		component := item.Component
		if component == "" {
			if len(item.Children) > 0 {
				component = "view/routerHolder.vue"
			} else {
				component = fmt.Sprintf("view/%s/index.vue", item.RouteName)
			}
		}
		sortOrder := item.Sort
		if sortOrder == 0 {
			sortOrder = i + 1
		}
		menu := sys.SysBaseMenu{
			ParentId: parentID, Name: item.RouteName, Path: item.RouteName,
			Component: component, Sort: sortOrder,
			Meta: sys.Meta{Title: item.Title, Icon: icon},
		}
		if err := db.Where("name = ?", item.RouteName).FirstOrCreate(&menu).Error; err != nil {
			return fmt.Errorf("flush menu %q: %w", item.RouteName, err)
		}
		bindMenuToAdmin(db, menu, adminID)
		if len(item.Children) > 0 {
			childPID := fmt.Sprintf("%d", menu.ID)
			if err := flushMenusRecursive(db, childPID, adminID, item.Children, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func bindMenuToAdmin(db *gorm.DB, menu sys.SysBaseMenu, adminID string) {
	var admin sys.SysAuthority
	if err := db.Where("authority_id = ?", adminID).First(&admin).Error; err != nil {
		return
	}
	_ = db.Model(&admin).Association("SysBaseMenus").Append(&menu)
}
